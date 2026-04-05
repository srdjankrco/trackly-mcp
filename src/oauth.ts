/**
 * MCP OAuth 2.1 authorization module.
 *
 * When MCP_AUTH_MODE=oauth, the MCP server acts as both a Protected Resource
 * and an OAuth 2.1 Authorization Server, delegating user authentication to
 * Azure Entra ID. This implements the full MCP authorization spec:
 *
 *   - RFC 9728  Protected Resource Metadata
 *   - RFC 8414  Authorization Server Metadata
 *   - RFC 7591  Dynamic Client Registration
 *   - OAuth 2.1 Authorization Code + PKCE
 *
 * Environment variables (required when MCP_AUTH_MODE=oauth):
 *   AZURE_TENANT_ID    – Azure Entra ID tenant ID
 *   AZURE_CLIENT_ID    – App registration (audience for tokens)
 *   AZURE_CLIENT_SECRET – App registration secret (for code exchange)
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { URL } from 'node:url';
import { bufferRequestBody, parsePositiveIntegerEnv, RequestBodyTooLargeError } from './http-utils.js';
import { createLogger } from './logger.js';

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

interface OAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_AUTHS = 1000;
const REGISTERED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REGISTERED_CLIENTS = 1000;
const LOOPBACK_PORT_MIN = 1024;
const LOOPBACK_PORT_MAX = 65535;
const logger = createLogger('oauth');

function getConfig(): OAuthConfig {
  const tenantId = process.env.AZURE_TENANT_ID ?? '';
  const clientId = process.env.AZURE_CLIENT_ID ?? '';
  const clientSecret = process.env.AZURE_CLIENT_SECRET ?? '';
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'MCP_AUTH_MODE=oauth requires AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET',
    );
  }
  return { tenantId, clientId, clientSecret };
}

/* ------------------------------------------------------------------ */
/*  JWKS – Azure Entra ID token validation                             */
/* ------------------------------------------------------------------ */

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS(tenantId: string) {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
  }
  return _jwks;
}

/**
 * Validate an Azure Entra ID JWT access token.
 * Returns true when the token is valid for this server's audience.
 */
export async function validateAccessToken(token: string): Promise<boolean> {
  const config = getConfig();
  try {
    const { payload } = await jwtVerify(token, getJWKS(config.tenantId), {
      issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      audience: [config.clientId, `api://${config.clientId}`],
    });

    // Optional domain restriction: only allow @dunavnet.eu users.
    const allowedDomain = process.env.MCP_ALLOWED_DOMAIN; // e.g. "dunavnet.eu"
    if (allowedDomain) {
      const upn = (payload.upn ?? payload.preferred_username ?? '') as string;
      if (!upn.toLowerCase().endsWith(`@${allowedDomain.toLowerCase()}`)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  In-memory stores (sufficient for MCP – few concurrent clients)     */
/* ------------------------------------------------------------------ */

/** Dynamically registered OAuth clients (RFC 7591). */
const clients = new Map<
  string,
  { redirect_uris: string[]; client_name?: string; token_endpoint_auth_method: string; expiresAt: number }
>();

/** Pending authorization requests awaiting Azure Entra ID callback. */
const pendingAuths = new Map<
  string,
  {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    expiresAt: number;
  }
>();

/** Authorization codes issued to MCP clients, awaiting token exchange. */
const authCodes = new Map<
  string,
  {
    azureToken: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    clientId: string;
    redirectUri: string;
    expiresAt: number;
  }
>();

/* ------------------------------------------------------------------ */
/*  TTL sweep — purge expired pending auths and auth codes             */
/* ------------------------------------------------------------------ */

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of clients) {
    if (entry.expiresAt < now) clients.delete(key);
  }
  for (const [key, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(key);
  }
  for (const [key, entry] of pendingAuths) {
    if (entry.expiresAt < now) pendingAuths.delete(key);
  }
}

// Run TTL sweep at a configurable interval (default: every 5 minutes).
const SWEEP_INTERVAL_MS = parseInt(process.env.OAUTH_CACHE_SWEEP_INTERVAL_MS || String(5 * 60 * 1000), 10);
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getBaseUrl(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers['host'] || 'localhost';
  const externalPath = process.env.MCP_EXTERNAL_PATH || '';
  return `${proto}://${host}${externalPath}`;
}

function bufferBody(req: IncomingMessage): Promise<Buffer> {
  const maxRequestBytes = parsePositiveIntegerEnv(
    process.env.MCP_MAX_REQUEST_BYTES,
    'MCP_MAX_REQUEST_BYTES',
    DEFAULT_MAX_REQUEST_BYTES,
  );
  return bufferRequestBody(req, maxRequestBytes);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const computed = createHash('sha256').update(verifier).digest('base64url');
    return computed === challenge;
  }
  return false; // Only S256 is accepted per OAuth 2.1
}

function isValidRegistrationRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Route handler — returns true if the path was an OAuth endpoint     */
/* ------------------------------------------------------------------ */

/**
 * Handle OAuth-related HTTP routes.  Call this before the `/mcp` handler.
 * Returns `true` when the request was consumed (caller should not continue).
 */
export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  try {
    // Protected Resource Metadata (RFC 9728)
    if (pathname === '/.well-known/oauth-protected-resource') {
      const baseUrl = getBaseUrl(req);
      sendJson(res, 200, {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ['header'],
      });
      return true;
    }

    // Authorization Server Metadata (RFC 8414)
    if (pathname === '/.well-known/oauth-authorization-server') {
      const baseUrl = getBaseUrl(req);
      sendJson(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256'],
      });
      return true;
    }

    // Dynamic Client Registration (RFC 7591)
    if (pathname === '/register' && req.method === 'POST') {
      return handleRegister(req, res);
    }

    // Authorization endpoint
    if (pathname === '/authorize' && req.method === 'GET') {
      return handleAuthorize(req, res);
    }

    // Azure Entra ID callback
    if (pathname === '/callback' && req.method === 'GET') {
      return handleCallback(req, res);
    }

    // Token endpoint
    if (pathname === '/token' && req.method === 'POST') {
      return handleToken(req, res);
    }

    return false;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: 'payload_too_large' });
      return true;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  /register — Dynamic Client Registration                           */
/* ------------------------------------------------------------------ */

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  sweepExpired();

  if (clients.size >= MAX_REGISTERED_CLIENTS) {
    sendJson(res, 503, {
      error: 'temporarily_unavailable',
      error_description: 'Too many registered OAuth clients. Please try again later.',
    });
    return true;
  }

  const body = await bufferBody(req);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'invalid_client_metadata' });
    return true;
  }

  const clientId = randomBytes(16).toString('hex');
  const redirectUris = Array.isArray(data.redirect_uris) ? (data.redirect_uris as string[]) : [];
  if (redirectUris.length === 0 || redirectUris.some((uri) => !isValidRegistrationRedirectUri(uri))) {
    sendJson(res, 400, {
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris must contain valid http or https URLs.',
    });
    return true;
  }

  const authMethod =
    typeof data.token_endpoint_auth_method === 'string'
      ? data.token_endpoint_auth_method
      : 'none';

  clients.set(clientId, {
    redirect_uris: redirectUris,
    client_name: typeof data.client_name === 'string' ? data.client_name : undefined,
    token_endpoint_auth_method: authMethod,
    expiresAt: Date.now() + REGISTERED_CLIENT_TTL_MS,
  });

  sendJson(res, 201, {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: data.client_name,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: authMethod,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/*  Trusted redirect URIs for public MCP clients (e.g. VS Code)        */
/*                                                                      */
/*  VS Code always redirects to either:                                 */
/*    - http://127.0.0.1:<port>  (loopback, Authorization Code flow)   */
/*    - https://vscode.dev/redirect  (remote / web flow)               */
/*                                                                      */
/*  These are safe to allow without prior /register because:            */
/*    1. Azure Entra ID is the real authentication gatekeeper.          */
/*    2. PKCE prevents code interception regardless of client state.    */
/*    3. Loopback URIs are non-routable; vscode.dev is Microsoft-owned. */
/* ------------------------------------------------------------------ */

function isTrustedPublicClientUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    // VS Code loopback: http on 127.0.0.1 with an ephemeral port (>= 1024)
    if (u.protocol === 'http:' && u.hostname === '127.0.0.1') {
      const port = parseInt(u.port, 10);
      const inRange = !isNaN(port) && port >= LOOPBACK_PORT_MIN && port <= LOOPBACK_PORT_MAX;
      return inRange;
    }
    // VS Code remote / web redirect
    if (uri === 'https://vscode.dev/redirect') return true;
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  /authorize — Start authorization (redirect to Azure Entra ID)      */
/* ------------------------------------------------------------------ */

async function handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  sweepExpired();
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';
  const state = url.searchParams.get('state') || '';

  if (!clientId || !redirectUri || !codeChallenge) {
    sendJson(res, 400, {
      error: 'invalid_request',
      error_description: 'Missing required parameters: client_id, redirect_uri, code_challenge',
    });
    return true;
  }

  if (!clients.has(clientId)) {
    // Self-heal: if the server restarted and lost the in-memory client registry,
    // accept any public client whose redirect_uri is a trusted VS Code URI.
    // The redirect_uri check is the security gate for public clients under OAuth 2.1.
    if (isTrustedPublicClientUri(redirectUri)) {
      if (clients.size >= MAX_REGISTERED_CLIENTS) {
        sendJson(res, 503, {
          error: 'temporarily_unavailable',
          error_description: 'Too many registered OAuth clients. Please try again later.',
        });
        return true;
      }

      clients.set(clientId, {
        redirect_uris: [redirectUri],
        client_name: 'VS Code (auto-restored)',
        token_endpoint_auth_method: 'none',
        expiresAt: Date.now() + REGISTERED_CLIENT_TTL_MS,
      });
    } else {
      sendJson(res, 400, { error: 'invalid_client' });
      return true;
    }
  }

  // Validate the redirect_uri matches what's registered for this client.
  const registeredClient = clients.get(clientId)!;
  if (!registeredClient.redirect_uris.includes(redirectUri)) {
    // Update registration if the URI is still a trusted public client URI
    // (e.g. VS Code rotated the loopback port).
    if (isTrustedPublicClientUri(redirectUri)) {
      registeredClient.redirect_uris.push(redirectUri);
      registeredClient.expiresAt = Date.now() + REGISTERED_CLIENT_TTL_MS;
    } else {
      sendJson(res, 400, { error: 'redirect_uri_mismatch' });
      return true;
    }
  }

  const config = getConfig();
  const baseUrl = getBaseUrl(req);

  if (pendingAuths.size >= MAX_PENDING_AUTHS) {
    sendJson(res, 503, {
      error: 'temporarily_unavailable',
      error_description: 'Too many pending authorization requests. Please try again shortly.',
    });
    return true;
  }

  // Store pending authorization keyed by a server-side state parameter
  const serverState = randomBytes(16).toString('hex');
  pendingAuths.set(serverState, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
    expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
  });

  // Redirect user's browser to Azure Entra ID
  const entraUrl = new URL(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`,
  );
  entraUrl.searchParams.set('client_id', config.clientId);
  entraUrl.searchParams.set('response_type', 'code');
  entraUrl.searchParams.set('redirect_uri', `${baseUrl}/callback`);
  // Use standard OIDC scopes — no api:// scope required (app need not expose API scopes).
  // The id_token returned always has aud=clientId which validateAccessToken accepts.
  entraUrl.searchParams.set('scope', 'openid profile email offline_access');
  entraUrl.searchParams.set('state', serverState);

  res.writeHead(302, { Location: entraUrl.toString() });
  res.end();
  return true;
}

/* ------------------------------------------------------------------ */
/*  /callback — Receive Azure Entra ID redirect, issue MCP auth code   */
/* ------------------------------------------------------------------ */

async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const azureCode = url.searchParams.get('code');
  const serverState = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    sendJson(res, 400, {
      error,
      error_description: url.searchParams.get('error_description') || '',
    });
    return true;
  }

  // Length limits to prevent memory exhaustion from oversized query params.
  if ((azureCode && azureCode.length > 2048) || (serverState && serverState.length > 512)) {
    sendJson(res, 400, { error: 'invalid_request' });
    return true;
  }

  if (!azureCode || !serverState || !pendingAuths.has(serverState)) {
    sendJson(res, 400, { error: 'invalid_request' });
    return true;
  }

  const pending = pendingAuths.get(serverState)!;
  pendingAuths.delete(serverState);
  if (pending.expiresAt < Date.now()) {
    sendJson(res, 400, {
      error: 'invalid_request',
      error_description: 'Authorization request expired. Please try again.',
    });
    return true;
  }

  const config = getConfig();
  const baseUrl = getBaseUrl(req);

  // Exchange the Azure authorization code for tokens (server-to-server)
  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: azureCode,
        redirect_uri: `${baseUrl}/callback`,
        grant_type: 'authorization_code',
      }),
    },
  );

  if (!tokenResponse.ok) {
    logger.error('Azure token exchange failed', { status: tokenResponse.status, body: await tokenResponse.text() });
    sendJson(res, 502, { error: 'upstream_token_exchange_failed' });
    return true;
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    id_token?: string;
  };

  // Prefer id_token (aud=clientId, always valid for validateAccessToken) over access_token
  // whose audience may be Microsoft Graph when only OIDC scopes were requested.
  const azureToken = tokenData.id_token ?? tokenData.access_token;

  // Issue our own authorization code for the MCP client
  const mcpCode = randomBytes(32).toString('hex');
  authCodes.set(mcpCode, {
    azureToken,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    expiresAt: Date.now() + 600_000, // 10 minutes
  });

  // Redirect browser back to the MCP client's redirect URI
  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set('code', mcpCode);
  if (pending.state) {
    redirectUrl.searchParams.set('state', pending.state);
  }

  res.writeHead(302, { Location: redirectUrl.toString() });
  res.end();
  return true;
}

/* ------------------------------------------------------------------ */
/*  /token — Exchange authorization code for access token              */
/* ------------------------------------------------------------------ */

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await bufferBody(req);
  const params = new URLSearchParams(body.toString());

  const grantType = params.get('grant_type');
  const code = params.get('code');
  const codeVerifier = params.get('code_verifier');
  const clientId = params.get('client_id');

  if (grantType !== 'authorization_code' || !code || !codeVerifier || !clientId) {
    sendJson(res, 400, {
      error: 'invalid_request',
      error_description: 'Required: grant_type=authorization_code, code, code_verifier, client_id',
    });
    return true;
  }

  const stored = authCodes.get(code);
  if (!stored || stored.clientId !== clientId || stored.expiresAt < Date.now()) {
    if (code) authCodes.delete(code);
    sendJson(res, 400, { error: 'invalid_grant' });
    return true;
  }

  // Verify PKCE (S256)
  if (!verifyPKCE(codeVerifier, stored.codeChallenge, stored.codeChallengeMethod)) {
    authCodes.delete(code);
    sendJson(res, 400, {
      error: 'invalid_grant',
      error_description: 'PKCE verification failed',
    });
    return true;
  }

  authCodes.delete(code);

  // Return the Azure Entra ID access token to the MCP client
  sendJson(res, 200, {
    access_token: stored.azureToken,
    token_type: 'Bearer',
    expires_in: 3600,
  });
  return true;
}
