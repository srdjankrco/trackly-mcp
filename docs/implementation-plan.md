# Implementation Plan: Trackly MCP Server Improvements

## Context

A comprehensive review identified 32 findings across 5 categories (Code Quality, Security, Performance, Installation & Deployment, UX). This plan addresses all of them in priority order.

---

## Phase 1: High-Priority Fixes

### 1.1 — Replace `any` types in transport.ts with proper SDK types
**File:** `src/transport.ts`
**Severity:** Medium (Code Quality)

The `ServerFactory` and `ServerLike` types use `any`, defeating TypeScript's type safety.

```typescript
// BEFORE (lines 40-44)
export type ServerFactory = () => any;
type ServerLike = { connect: (...args: any[]) => any; close: (...args: any[]) => any };

// AFTER
import type { Server } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export type ServerFactory = () => Server;

type ServerLike = Server & {
  connect(transport: StreamableHTTPServerTransport | StdioServerTransport): Promise<void>;
};
```

Note: The `StdioServerTransport` and `StreamableHTTPServerTransport` both have a `.close()` method and the `Server` interface from the SDK should cover the rest. Verify at runtime since SDK types may vary.

**Verification:** Run `npm run typecheck` — no `any`-related errors.

---

### 1.2 — Change CORS default from `*` to restrictive
**Files:** `src/transport.ts:168`, `docker-compose.yml:14`, `.env.example:49`
**Severity:** High (Security)

**transport.ts:**
```typescript
// BEFORE
'Access-Control-Allow-Origin': process.env.MCP_CORS_ORIGIN || '*',

// AFTER — default to empty string (no CORS unless explicitly configured)
'Access-Control-Allow-Origin': process.env.MCP_CORS_ORIGIN || '',
```

Also add validation: if `MCP_CORS_ORIGIN` is set to `*` in production mode, log a warning.

**docker-compose.yml:**
```yaml
# BEFORE
MCP_CORS_ORIGIN: ${MCP_CORS_ORIGIN:-*}

# AFTER
MCP_CORS_ORIGIN: ${MCP_CORS_ORIGIN:-}
```

**`.env.example`:**
```
# Optional: CORS origin for browser-based MCP clients (default: empty = no CORS)
# For development with browser-based clients, set to http://localhost:PORT
# WARNING: Never use * in production
MCP_CORS_ORIGIN=
```

---

### 1.3 — Add environment validation on startup with clear error messages
**Files:** `src/mcp-server.ts`, `src/config.ts`
**Severity:** High (Security / UX)

The server currently validates Trackly config but doesn't validate MCP HTTP config early enough and doesn't provide clear startup messages.

**In `config.ts`**, add a new export:
```typescript
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateStartup(env: NodeJS.ProcessEnv = process.env): ConfigValidationResult {
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
    if (authMode === 'oauth' && (!env.AZURE_TENANT_ID?.trim() || !env.AZURE_CLIENT_ID?.trim() || !env.AZURE_CLIENT_SECRET?.trim())) {
      errors.push('AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET are required when MCP_AUTH_MODE=oauth');
    }
    if (env.MCP_CORS_ORIGIN === '*') {
      warnings.push('MCP_CORS_ORIGIN=* allows all origins. Use a specific origin in production.');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**In `mcp-server.ts`**, call this before creating the server and print a startup banner:
```typescript
async function main(): Promise<void> {
  const { valid, errors, warnings } = validateStartup();
  for (const w of warnings) console.warn(`[trackly-mcp] WARNING: ${w}`);
  if (!valid) {
    for (const e of errors) console.error(`[trackly-mcp] ERROR: ${e}`);
    process.exit(1);
  }
  await startServer(createTracklyServer, "trackly-mcp");
}
```

---

## Phase 2: Medium-Priority Fixes

### 2.1 — Pin Docker base images to SHA256 digest
**File:** `Dockerfile`
**Severity:** Medium (Security / Supply Chain)

```dockerfile
# Resolve digests once (run: docker pull node:20-slim --quiet)
FROM node:20-slim@sha256:8ccb722c3e42e7a8a22a5c4a5b8d8f5e4c3a2b1d0e9f8a7b6c5d4e3f2a1b0c9 AS builder
FROM node:20-slim@sha256:8ccb722c3e42e7a8a22a5c4a5b8d8f5e4c3a2b1d0e9f8a7b6c5d4e3f2a1b0c9 AS runtime
```

**Note:** Replace with actual digests after running `docker pull node:20-slim` in the target deployment environment.

---

### 2.2 — Add input sanitization for user-provided strings
**File:** `src/trackly-client.ts`
**Severity:** Medium (Security)

```typescript
// Add near the top of the file, after imports
const MAX_STRING_LENGTH = 10_000;
const STRING_SANITIZE_REGEX = /[\x00-\x1F\x7F]/g; // strip control chars

function sanitizeString(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(STRING_SANITIZE_REGEX, '')
    .trim()
    .slice(0, MAX_STRING_LENGTH);
}
```

Apply in `createTask`:
```typescript
// In createTask():
const payload: Record<string, unknown> = {
  title: sanitizeString(input.title),
  description: sanitizeString(input.description ?? ""),
  planId,
};
```

Apply in `addComment`:
```typescript
// In addComment():
await this.requestVoid(..., {
  body: JSON.stringify({
    content: sanitizeString(comment),
    contentType: "text",
  }),
});
```

---

### 2.3 — Add port range restriction for trusted loopback URIs
**File:** `src/oauth.ts`
**Severity:** Medium (Security)

```typescript
const LOOPBACK_PORT_MIN = 1024;
const LOOPBACK_PORT_MAX = 65535;

function isTrustedPublicClientUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    // VS Code loopback: http on 127.0.0.1 with an ephemeral port
    if (u.protocol === 'http:' && u.hostname === '127.0.0.1') {
      const port = parseInt(u.port, 10);
      const inRange = !isNaN(port) && port >= LOOPBACK_PORT_MIN && port <= LOOPBACK_PORT_MAX;
      return inRange;
    }
    if (uri === 'https://vscode.dev/redirect') return true;
    return false;
  } catch {
    return false;
  }
}
```

---

### 2.4 — Add session limits with LRU eviction
**Files:** `src/transport.ts`
**Severity:** Medium (Performance)

```typescript
const MAX_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS || '100', 10);
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ServerLike; lastUsed: number }>();

// When adding a new session:
if (sessions.size >= MAX_SESSIONS) {
  // Evict the least recently used session
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
    console.error(`${name}: evicted oldest session ${oldestKey} (${sessions.size} -> ${sessions.size - 1})`);
  }
}

// Update lastUsed on access:
sessions.set(sid, { transport, server: sessionServer, lastUsed: Date.now() });
```

Also update the `sessions.size` display in the health endpoint.

---

### 2.5 — Improve HTTP method validation with `Allow` header
**File:** `src/transport.ts`
**Severity:** Low (Security)

```typescript
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE', 'OPTIONS']);

if (!ALLOWED_METHODS.has(req.method ?? '')) {
  res.writeHead(405, { 'Allow': 'GET, POST, DELETE, OPTIONS' }).end();
  return;
}
```

---

### 2.6 — Add jitter to retry backoff
**File:** `src/trackly-client.ts`
**Severity:** Low (Performance)

```typescript
private getBackoffMs(attempt: number, status?: number): number {
  const base = status === 429 ? 500 : 300;
  const exponential = base * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.3 * exponential; // 0-30% jitter
  return Math.floor(exponential + jitter);
}
```

---

### 2.7 — Add retry with distinction between transient and permanent failures
**File:** `src/trackly-client.ts`
**Severity:** Low (Performance)

```typescript
// In request():
if (response.ok) {
  this.lastRequestAt = Date.now();
  return response;
}

// Only retry on transient failures
const isRetryable = response.status === 429 ||
                    response.status >= 500 ||
                    response.status === 0; // network error

if (!isRetryable) {
  throw new TracklyClientError(`Request failed with status ${response.status} for ${url}`, response.status);
}
```

---

### 2.8 — Add JSON parse validation in requestJson
**File:** `src/trackly-client.ts`
**Severity:** Low (Code Quality)

```typescript
private async requestJson<T>(url: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
  const response = await this.request(url, init, allowRetry);
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TracklyClientError(`Invalid JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}
```

---

### 2.9 — Add MCP_HOST environment variable
**File:** `src/transport.ts`
**Severity:** Low (Security)

```typescript
const host = process.env.MCP_HOST || '127.0.0.1'; // Default to loopback for security
httpServer.listen(port, host, () => {
  console.error(`${name} MCP server listening on http://${host}:${port}/mcp`);
});
```

---

### 2.10 — Configure HTTP keep-alive
**File:** `src/transport.ts`
**Severity:** Low (Performance)

```typescript
import http from 'node:http';

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 25,
  maxFreeSockets: 5,
  timeout: 60_000,
});

// Use in fetch calls by passing agent in options (or configure globally)
// For now, note that global fetch doesn't use node Agent by default.
// Consider using a custom fetch wrapper or Node 20+ agent option.
```

**Note:** Node.js 20+ `fetch` uses a global agent. Pass `dispatcher` option or set `node-fetch-max-sockets` if needed.

---

### 2.11 — Add error codes to fail() responses
**File:** `src/mcp-server.ts`
**Severity:** Info (UX)

```typescript
function fail(error: unknown, code = 'ERR'): { content: [{ type: "text"; text: string }]; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = error instanceof TracklyClientError && error.status
    ? `${error.status}`
    : code;
  return {
    content: [{ type: "text" as const, text: `[${errorCode}] ${message}` }],
    isError: true,
  };
}
```

---

### 2.12 — Enhance health endpoint diagnostics
**File:** `src/transport.ts`
**Severity:** Info (UX)

```typescript
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
```

---

### 2.13 — Add tool usage examples to descriptions
**File:** `src/mcp-server.ts`
**Severity:** Medium (UX)

Update tool descriptions to include usage examples. Example for `list_tasks`:
```typescript
server.tool(
  "list_tasks",
  `List Trackly tasks, optionally filtered by plan, status, assignee, or mine-only.

Examples:
  list_tasks({})                                    // all tasks
  list_tasks({ plan_id: "My Project" })             // by project
  list_tasks({ status: "In Progress" })             // by status
  list_tasks({ mine_only: true })                   // assigned to me
  list_tasks({ completed_in_last_days: 7 })         // completed this week`,
  { ... },
);
```

Apply the same pattern to all other tools (`create_task`, `update_task_status`, `add_comment`, etc.).

---

### 2.14 — Improve `.env.example` organization
**File:** `.env.example`
**Severity:** Info (UX)

```bash
# =============================================================================
# Trackly API — REQUIRED
# =============================================================================
KANBAN_PROJECT_URL=https://trackly-api.azurewebsites.net

# Auth mode: bearer | password-login | apikey-login
# bearer:        use KANBAN_TOKEN directly
# apikey-login:  login with TRACKLY_EMAIL + TRACKLY_API_KEY (recommended)
# password-login: login with TRACKLY_EMAIL + TRACKLY_PASSWORD
TRACKLY_AUTH_MODE=apikey-login
TRACKLY_EMAIL=you@example.com
TRACKLY_API_KEY=your_api_key_here

# Only needed if TRACKLY_AUTH_MODE=bearer
# KANBAN_TOKEN=

# Only needed if TRACKLY_AUTH_MODE=password-login
# TRACKLY_PASSWORD=

# =============================================================================
# MCP Server — REQUIRED for HTTP mode
# =============================================================================
# Set MCP_HTTP_PORT to enable HTTP mode (omit or set to 0 for stdio)
MCP_HTTP_PORT=3000

# Auth mode for MCP HTTP connections: apikey | oauth
MCP_AUTH_MODE=apikey

# Required when MCP_AUTH_MODE=apikey and MCP_HTTP_PORT is set
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MCP_API_KEY=

# Optional: bind address (default: 127.0.0.1 for security)
# Set to 0.0.0.0 to expose on all interfaces (only for development)
# MCP_HOST=127.0.0.1

# Optional: max concurrent sessions (default: 100)
# MCP_MAX_SESSIONS=100

# Optional: restrict OAuth logins to a specific email domain (e.g. example.com)
# MCP_ALLOWED_DOMAIN=

# =============================================================================
# Azure Entra ID — REQUIRED when MCP_AUTH_MODE=oauth
# =============================================================================
# AZURE_TENANT_ID=
# AZURE_CLIENT_ID=
# AZURE_CLIENT_SECRET=

# =============================================================================
# Optional Configuration
# =============================================================================
# Default project/workspace filters
# TRACKLY_PROJECT_ID=
# TRACKLY_WORKSPACE_ID=

# Request tuning (uncomment to override defaults)
# TRACKLY_RATE_LIMIT_MS=300
# TRACKLY_MAX_RETRIES=3
# TRACKLY_TIMEOUT_MS=30000
# MCP_MAX_REQUEST_BYTES=1048576

# Logging
LOG_LEVEL=info
```

---

### 2.15 — Deduplicate health check between Dockerfile and docker-compose
**File:** `docker-compose.yml`, `Dockerfile`
**Severity:** Info (Deployment)

Keep health check in `docker-compose.yml` only. Remove from `Dockerfile`:
```dockerfile
# Remove this line from Dockerfile:
# HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
#   CMD node -e "fetch('http://localhost:3000/health')..."
```

---

### 2.16 — Pass CLI arguments through start script
**File:** `package.json`
**Severity:** Low (Deployment)

```json
"start": "node dist/mcp-server.js",
```
Leave as-is for now since Node.js doesn't natively support `"$@"` in npm scripts. For CLI argument passing, users should run `node dist/mcp-server.js` directly. Add a note in README.

---

### 2.17 — Make TTL sweep configurable
**File:** `src/oauth.ts`
**Severity:** Low (Performance)

```typescript
const SWEEP_INTERVAL_MS = parseInt(process.env.OAUTH_CACHE_SWEEP_INTERVAL_MS || String(5 * 60 * 1000), 10);
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();
```

---

## Phase 3: Test Coverage Improvements

### 3.1 — Add missing test cases
**File:** `src/__tests__/`

**transport.test.ts** — add:
- Test for session eviction when `MAX_SESSIONS` is reached
- Test for health endpoint returning enhanced diagnostics
- Test for HTTP method validation (405 on PUT/PATCH)
- Test for CORS preflight (OPTIONS)

**oauth.test.ts** — add:
- Test for `isTrustedPublicClientUri` with port range restrictions
- Test for expired pending auth cleanup

**trackly-client.test.ts** — add:
- Test for `sanitizeString` behavior
- Test for JSON parse failure in `requestJson`
- Test for transient vs permanent failure retry distinction
- Test for `resolveBucketIdByStatus` returning null

**config.test.ts** — add:
- Test for `validateStartup` function (Phase 1.3)

---

## Phase 4: Documentation Improvements

### 4.1 — Add troubleshooting section to README
**File:** `README.md`
**Severity:** Medium (UX)

Add new section before or after Development:

```markdown
## Troubleshooting

### Connection refused / timeout
- Ensure `MCP_HTTP_PORT` is set to enable HTTP mode
- Check the server is listening: `curl http://localhost:3000/health`
- Verify firewall/network rules if connecting remotely

### 401 Unauthorized
- In `apikey` mode: ensure `MCP_API_KEY` matches exactly (check for trailing spaces)
- In `oauth` mode: ensure Azure credentials are set and the token hasn't expired
- Run `node dist/mcp-server.js` locally in stdio mode to verify Trackly credentials

### "No bucket found for status"
- Status names are case-insensitive but must match exactly
- Use `list_tasks({ plan_id: "Your Project" })` first to see valid statuses

### Server starts but MCP client can't connect
- For Claude Desktop (stdio): ensure `MCP_HTTP_PORT` is NOT set
- For remote MCP clients (SSE): ensure `MCP_API_KEY` is set and the client sends `Authorization: Bearer <key>`
- Check CORS: if using browser-based clients, set `MCP_CORS_ORIGIN` to the client's origin

### Health check fails in Docker
```bash
docker exec <container> node -e "fetch('http://localhost:3000/health').then(r=>r.json()).then(console.log)"
```
```

### 4.2 — Add validation script to package.json
**File:** `package.json`
**Severity:** High (UX)

```json
"scripts": {
  ...
  "validate-env": "node -e \"const {errors,warnings}=require('./dist/config.js').validateStartup();warnings.forEach(w=>console.warn('WARN:',w));if(errors.length){errors.forEach(e=>console.error('ERROR:',e));process.exit(1)}console.log('All required environment variables are set.')\""
}
```

Or as a TypeScript script in `src/scripts/validate-env.ts` that can be run with `tsx`.

---

## Summary

| # | Task | Severity | Phase |
|---|------|----------|-------|
| 1.1 | Replace `any` types with SDK types | Medium | 1 |
| 1.2 | Change CORS default from `*` | High | 1 |
| 1.3 | Add startup env validation with clear errors | High | 1 |
| 2.1 | Pin Docker base images to SHA digest | Medium | 2 |
| 2.2 | Add input sanitization | Medium | 2 |
| 2.3 | Add port range for trusted loopback URIs | Medium | 2 |
| 2.4 | Add session limits with LRU eviction | Medium | 2 |
| 2.5 | Improve HTTP method validation with Allow header | Low | 2 |
| 2.6 | Add retry jitter | Low | 2 |
| 2.7 | Distinguish transient vs permanent failures | Low | 2 |
| 2.8 | Add JSON parse validation | Low | 2 |
| 2.9 | Add MCP_HOST env var | Low | 2 |
| 2.10 | Configure HTTP keep-alive | Low | 2 |
| 2.11 | Add error codes to fail() | Info | 2 |
| 2.12 | Enhance health endpoint | Info | 2 |
| 2.13 | Add tool usage examples | Medium | 2 |
| 2.14 | Improve `.env.example` | Info | 2 |
| 2.15 | Deduplicate health check | Info | 2 |
| 2.16 | CLI argument passing note | Low | 2 |
| 2.17 | Make TTL sweep configurable | Low | 2 |
| 3.1 | Add missing test cases | Medium | 3 |
| 4.1 | Add troubleshooting section | Medium | 4 |
| 4.2 | Add validate-env script | High | 4 |

**Total: 24 actionable tasks across 4 phases.**

Execution order: Phase 1 (all) → Phase 2 (in listed order) → Phase 3 → Phase 4.
