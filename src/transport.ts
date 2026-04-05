/**
 * Dual-mode transport helper: stdio (default) or HTTP (when MCP_HTTP_PORT is set).
 *
 * Usage in any MCP server entry point:
 *
 *   import { startServer } from './transport.js';
 *   // Factory form (recommended for HTTP multi-client):
 *   await startServer(() => buildServer(), 'trackly-mcp');
 *   // Direct Server form (stdio / single-client):
 *   await startServer(server, 'trackly-mcp');
 *
 * Authentication modes (MCP_AUTH_MODE env):
 *   - "apikey" (default): Bearer-token via MCP_API_KEY
 *   - "oauth":  MCP OAuth 2.1 with Azure Entra ID
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { bufferRequestBody, parsePositiveIntegerEnv, RequestBodyTooLargeError } from './http-utils.js';
import { createLogger } from './logger.js';
import { handleOAuthRoute, validateAccessToken } from './oauth.js';

/* ------------------------------------------------------------------ */
/*  Startup validation                                                  */
/* ------------------------------------------------------------------ */

export interface StartupValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const logger = createLogger('transport');

export function validateStartup(env: NodeJS.ProcessEnv = process.env): StartupValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const port = parseInt(env.MCP_HTTP_PORT || '0', 10);

  if (!env.KANBAN_PROJECT_URL?.trim()) {
    errors.push('KANBAN_PROJECT_URL is required');
  }

  if (port > 0) {
    const authMode = (env.MCP_AUTH_MODE || 'apikey').toLowerCase();
    if (authMode !== 'apikey' && authMode !== 'oauth') {
      errors.push('MCP_AUTH_MODE must be one of: apikey, oauth');
    }
    if (authMode === 'apikey' && !env.MCP_API_KEY?.trim()) {
      errors.push('MCP_API_KEY is required when MCP_HTTP_PORT is set with MCP_AUTH_MODE=apikey');
    }
    if (authMode === 'oauth') {
      if (!env.AZURE_TENANT_ID?.trim()) errors.push('AZURE_TENANT_ID is required when MCP_AUTH_MODE=oauth');
      if (!env.AZURE_CLIENT_ID?.trim()) errors.push('AZURE_CLIENT_ID is required when MCP_AUTH_MODE=oauth');
      if (!env.AZURE_CLIENT_SECRET?.trim()) errors.push('AZURE_CLIENT_SECRET is required when MCP_AUTH_MODE=oauth');
    }
    if (env.MCP_CORS_ORIGIN === '*') {
      warnings.push('MCP_CORS_ORIGIN=* allows all origins — not suitable for production');
    }
    if (!env.MCP_HOST && authMode === 'apikey') {
      warnings.push('MCP_HOST is not set — defaulting to 127.0.0.1 (loopback). Set to 0.0.0.0 to expose on all interfaces.');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Starts an MCP server in stdio or HTTP mode depending on environment.
 *
 * @param serverOrFactory - A Server instance (single-client) or a factory
 *   function that returns a new Server for each HTTP session (multi-client).
 * @param name - Display name used in log messages.
 *
 * HTTP mode (MCP_HTTP_PORT set):
 *   - Creates a per-session StreamableHTTPServerTransport + Server.
 *   - Supports concurrent clients when a factory is provided.
 *   - `MCP_AUTH_MODE=apikey` (default): optional `MCP_API_KEY` Bearer-token auth.
 *   - `MCP_AUTH_MODE=oauth`: MCP OAuth 2.1 flow via Azure Entra ID.
 * Stdio mode (default):
 *   - Single connection via StdioServerTransport.
 */
/** Factory function that creates a fresh McpServer per session. */
export type ServerFactory = () => McpServer;

/** A connected server instance that speaks MCP over a transport. */
type ServerLike = {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
};

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

function hasOAuthConfiguration(): boolean {
  return Boolean(
    process.env.AZURE_TENANT_ID?.trim() &&
    process.env.AZURE_CLIENT_ID?.trim() &&
    process.env.AZURE_CLIENT_SECRET?.trim(),
  );
}

function validateHttpConfiguration(port: number, authMode: string, apiKey: string | null): void {
  if (port <= 0) {
    return;
  }

  if (authMode !== 'apikey' && authMode !== 'oauth') {
    throw new Error('MCP_AUTH_MODE must be one of: apikey, oauth');
  }

  if (authMode === 'apikey' && !apiKey) {
    throw new Error('MCP_API_KEY is required when HTTP mode is enabled with MCP_AUTH_MODE=apikey');
  }

  if (authMode === 'oauth' && !hasOAuthConfiguration()) {
    throw new Error(
      'AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET are required when MCP_AUTH_MODE=oauth',
    );
  }
}

function getConfiguredApiKey(rawApiKey: string | undefined): string | null {
  const trimmed = rawApiKey?.trim() ?? '';
  if (!trimmed) {
    return null;
  }

  // Keep parity with the shared transport used by the GrantAgent MCPs.
  if (trimmed.toLowerCase() === 'not-set') {
    return null;
  }

  return trimmed;
}

function getAuthorizationHeader(authHeader: string | string[] | undefined): string {
  return Array.isArray(authHeader) ? (authHeader[0] ?? '') : (authHeader ?? '');
}

function getBearerToken(authHeader: string | string[] | undefined): string | null {
  const authorization = getAuthorizationHeader(authHeader);
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
}

function matchesBearerApiKey(
  authHeader: string | string[] | undefined,
  apiKey: string | null,
): boolean {
  if (!apiKey) {
    return false;
  }

  const expected = `Bearer ${apiKey}`;
  const actual = getAuthorizationHeader(authHeader);

  return expected.length === actual.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export async function startServer(
  serverOrFactory: ServerLike | ServerFactory,
  name: string,
): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || '0', 10);

  if (port > 0) {
    const authMode = (process.env.MCP_AUTH_MODE || 'apikey').toLowerCase();
    const apiKey = getConfiguredApiKey(process.env.MCP_API_KEY);
    const maxRequestBytes = parsePositiveIntegerEnv(
      process.env.MCP_MAX_REQUEST_BYTES,
      'MCP_MAX_REQUEST_BYTES',
      DEFAULT_MAX_REQUEST_BYTES,
    );
    const useOAuth = authMode === 'oauth';
    const factory = typeof serverOrFactory === 'function' ? serverOrFactory : null;

    validateHttpConfiguration(port, authMode, apiKey);

    const MAX_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS || '100', 10);

    // Map of sessionId → { transport, server, lastUsed } for multi-client support.
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ServerLike; lastUsed: number }>();

    const httpServer = createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const startedAt = Date.now();

        res.on('finish', () => {
          logger.debug('HTTP request completed', {
            method: req.method,
            path: requestUrl.pathname,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
          });
        });

        if (requestUrl.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            sessions: sessions.size,
            maxSessions: MAX_SESSIONS,
            uptime: Math.floor(process.uptime()),
            memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          }));
          return;
        }

        if (requestUrl.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', endpoint: '/mcp' }));
          return;
        }

        // --- OAuth routes (only active when MCP_AUTH_MODE=oauth) ---
        if (useOAuth) {
          const handled = await handleOAuthRoute(req, res, requestUrl.pathname);
          if (handled) return;
        }

        if (requestUrl.pathname !== '/mcp') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
          return;
        }

        // --- CORS for /mcp (needed for browser-based MCP clients) ---
        // CORS preflight (OPTIONS) must be handled before auth since
        // browsers do not attach Authorization headers to preflight requests.
        const corsOrigin = process.env.MCP_CORS_ORIGIN?.trim();
        const corsHeaders: Record<string, string> = corsOrigin
          ? {
              'Access-Control-Allow-Origin': corsOrigin,
              'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
              'Access-Control-Expose-Headers': 'Mcp-Session-Id',
            }
          : {};

        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        // Attach CORS headers to all /mcp responses.
        for (const [k, v] of Object.entries(corsHeaders)) {
          res.setHeader(k, v);
        }

        // --- Authentication ---
        const authHeader = req.headers['authorization'];

        if (matchesBearerApiKey(authHeader, apiKey)) {
          // Shared API key accepted in both apikey mode and oauth mode.
        } else if (useOAuth) {
          // OAuth mode: validate Azure Entra ID JWT
          const token = getBearerToken(authHeader);
          if (!token || !(await validateAccessToken(token))) {
            const externalPath = process.env.MCP_EXTERNAL_PATH || '';
            const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost'}${externalPath}`;
            res.writeHead(401, {
              'Content-Type': 'application/json',
              'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
            });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
        } else if (apiKey) {
          // API-key mode: constant-time bearer token check
          if (!matchesBearerApiKey(authHeader, apiKey)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
        }

        const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE', 'OPTIONS']);
        if (!ALLOWED_METHODS.has(req.method ?? '')) {
          res.writeHead(405, { 'Allow': 'GET, POST, DELETE, OPTIONS' }).end();
          return;
        }

        // --- Route by session ID ---
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId) {
          const entry = sessions.get(sessionId);
          if (!entry) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Unknown session' },
              id: null,
            }));
            return;
          }
          entry.lastUsed = Date.now();
          await entry.transport.handleRequest(req, res);
          return;
        }

        // No session header — only valid for a POST containing `initialize`.
        if (req.method !== 'POST') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
            id: null,
          }));
          return;
        }

        // Buffer the body to check for `initialize`.
        const body = await bufferRequestBody(req, maxRequestBytes);
        let isInitialize = false;
        try {
          const parsed = JSON.parse(body.toString());
          if (Array.isArray(parsed)) {
            isInitialize = parsed.some((m: { method?: string }) => m.method === 'initialize');
          } else {
            isInitialize = parsed.method === 'initialize';
          }
        } catch {
          // Not valid JSON — let the transport deal with the error.
        }

        if (!isInitialize) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
            id: null,
          }));
          return;
        }

        // Pre-generate session ID so we can register *before* handleRequest
        // (which may keep an SSE stream open and not resolve immediately).
        const sid = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sid,
        });

        // Obtain a Server for this session — either fresh from factory or
        // re-use the single instance (closing its previous connection first).
        let sessionServer: ServerLike;
        try {
          if (factory) {
            sessionServer = factory();
          } else {
            sessionServer = serverOrFactory as ServerLike;
            try { await sessionServer.close(); } catch { /* not connected yet */ }
          }

          // Clean up on session close.
          transport.onclose = () => {
            sessions.delete(sid);
            if (factory) {
              sessionServer.close().catch((err: unknown) =>
                logger.error('Session close error', { serverName: name, error: String(err) }),
              );
            }
          };

          await sessionServer.connect(transport);
        } catch (err) {
          logger.error('Session setup failed', { serverName: name, error: String(err) });
          await transport.close().catch(() => {});
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error: session setup failed' },
            id: null,
          }));
          return;
        }

        // Evict oldest session if at capacity.
        if (sessions.size >= MAX_SESSIONS) {
          let oldestKey: string | null = null;
          let oldestTime = Infinity;
          for (const [key, entry] of sessions) {
            if (entry.lastUsed < oldestTime) {
              oldestTime = entry.lastUsed;
              oldestKey = key;
            }
          }
          if (oldestKey) {
            const evicted = sessions.get(oldestKey)!;
            evicted.transport.close().catch(() => {});
            evicted.server.close().catch(() => {});
            sessions.delete(oldestKey);
            logger.warn('Evicted oldest session', { serverName: name, sessionId: oldestKey, limit: MAX_SESSIONS });
          }
        }

        // Register session BEFORE handleRequest so follow-up requests can
        // find it even if handleRequest keeps an SSE stream open.
        sessions.set(sid, { transport, server: sessionServer, lastUsed: Date.now() });

        // Pass the already-consumed body as parsedBody (3rd arg).
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(body.toString());
        } catch { /* let transport handle parse error */ }
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        if (res.headersSent) {
          logger.error('Request handling failed after headers were sent', { serverName: name, error: String(error) });
          return;
        }

        if (error instanceof RequestBodyTooLargeError) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
          return;
        }

        logger.error('Request handling failed', { serverName: name, error: String(error) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });

    const host = process.env.MCP_HOST || '127.0.0.1';
    httpServer.listen(port, host, () => {
      logger.info('MCP HTTP server listening', { serverName: name, host, port, endpoint: '/mcp' });
    });

    // --- Graceful shutdown ---
    const shutdown = async () => {
      logger.info('Shutting down MCP HTTP server', { serverName: name, activeSessions: sessions.size });
      httpServer.close();
      const closing = [...sessions.values()].map(({ server: s }) =>
        s.close().catch((err: unknown) => logger.error('Session close error during shutdown', { serverName: name, error: String(err) })),
      );
      await Promise.allSettled(closing);
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else {
    const server = typeof serverOrFactory === 'function' ? serverOrFactory() : serverOrFactory;
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP stdio server running', { serverName: name });
  }
}
