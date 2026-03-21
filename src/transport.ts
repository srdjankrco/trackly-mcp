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
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { handleOAuthRoute, validateAccessToken } from './oauth.js';

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
/** Factory function that creates a fresh Server per session. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerFactory = () => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerLike = { connect: (...args: any[]) => any; close: (...args: any[]) => any };

export async function startServer(
  serverOrFactory: ServerLike | ServerFactory,
  name: string,
): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || '0', 10);

  if (port > 0) {
    const authMode = (process.env.MCP_AUTH_MODE || 'apikey').toLowerCase();
    const apiKey = process.env.MCP_API_KEY;
    const useOAuth = authMode === 'oauth';
    const factory = typeof serverOrFactory === 'function' ? serverOrFactory : null;

    // Map of sessionId → { transport, server } for multi-client support.
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ServerLike }>();

    function bufferBody(req: IncomingMessage): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
    }

    const httpServer = createServer(async (req, res) => {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (requestUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
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
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': process.env.MCP_CORS_ORIGIN || '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      };

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
      if (useOAuth) {
        // OAuth mode: validate Azure Entra ID JWT
        const auth = req.headers['authorization'];
        const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
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
        const expected = `Bearer ${apiKey}`;
        const actual = req.headers['authorization'] || '';
        const match = expected.length === actual.length &&
          timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
        if (!match) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
        res.writeHead(405).end();
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
      const body = await bufferBody(req);
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
              console.error(`${name}: session close error:`, err),
            );
          }
        };

        await sessionServer.connect(transport);
      } catch (err) {
        console.error(`${name}: session setup failed:`, err);
        await transport.close().catch(() => {});
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error: session setup failed' },
          id: null,
        }));
        return;
      }

      // Register session BEFORE handleRequest so follow-up requests can
      // find it even if handleRequest keeps an SSE stream open.
      sessions.set(sid, { transport, server: sessionServer });

      // Pass the already-consumed body as parsedBody (3rd arg).
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body.toString());
      } catch { /* let transport handle parse error */ }
      await transport.handleRequest(req, res, parsedBody);
    });

    httpServer.listen(port, () => {
      console.error(`${name} MCP server listening on http://0.0.0.0:${port}/mcp`);
    });

    // --- Graceful shutdown ---
    const shutdown = async () => {
      console.error(`${name}: shutting down (${sessions.size} active sessions)...`);
      httpServer.close();
      const closing = [...sessions.values()].map(({ server: s }) =>
        s.close().catch((err: unknown) => console.error(`${name}: session close error:`, err)),
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
    console.error(`${name} MCP server running on stdio`);
  }
}
