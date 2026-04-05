# Trackly MCP

`trackly-mcp` is a standalone MCP server for working with Trackly projects, tasks, comments, and bucket/status updates.

It supports both **stdio** (local CLI) and **HTTP** (remote/Docker) transport modes, with optional OAuth 2.1 (Azure Entra ID) or API-key authentication.

HTTP mode is intentionally fail-closed: the server will not start unless you configure either:
- `MCP_AUTH_MODE=apikey` with a non-empty `MCP_API_KEY`
- `MCP_AUTH_MODE=oauth` with `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`

When `MCP_AUTH_MODE=oauth`, the server can still accept `Authorization: Bearer <MCP_API_KEY>` if `MCP_API_KEY` is configured. This keeps remote clients compatible with the same shared-secret setup used by the GrantAgent MCP servers.

## Tools

| Tool | Description |
|------|-------------|
| `trackly-howto` | Usage guide and configuration help |
| `whoami` | Show current authenticated user |
| `list_projects` | List all accessible projects |
| `list_tasks` | List tasks with optional filters (project, assignee, status) |
| `get_task` | Get full task details by ID |
| `create_task` | Create a new task in a project |
| `update_task_status` | Change task status (e.g. Todo → In Progress → Done) |
| `add_comment` | Add a comment to a task |
| `list_comments` | List comments on a task |

## Environment Variables

### Trackly API (required)

| Variable | Description | Default |
|----------|-------------|---------|
| `KANBAN_PROJECT_URL` | Trackly API base URL | — |
| `TRACKLY_AUTH_MODE` | Auth mode: `bearer`, `apikey-login`, `password-login` | `bearer` |
| `TRACKLY_EMAIL` | User email (required for `apikey-login` / `password-login`) | — |
| `TRACKLY_API_KEY` | API key (for `apikey-login`) | — |
| `TRACKLY_PASSWORD` | Password (for `password-login`) | — |
| `KANBAN_TOKEN` | Bearer token (for `bearer`) | — |

### Trackly API (optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `TRACKLY_PROJECT_ID` | Default project ID filter | — |
| `TRACKLY_WORKSPACE_ID` | Workspace ID | — |
| `LOG_LEVEL` | Logging level: `debug`, `info`, `warn`, `error` | `info` |
| `TRACKLY_RATE_LIMIT_MS` | Min delay between API calls (ms) | `300` |
| `TRACKLY_MAX_RETRIES` | Max retries on transient failures | `3` |
| `TRACKLY_TIMEOUT_MS` | HTTP request timeout (ms) | `30000` |

### MCP Transport & Auth

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_HTTP_PORT` | HTTP port (omit or `0` for stdio mode) | — |
| `MCP_HOST` | Bind address for HTTP mode. Use `0.0.0.0` for Docker or reverse-proxy deployments. | `127.0.0.1` |
| `MCP_AUTH_MODE` | MCP auth: `apikey` or `oauth` | `apikey` |
| `MCP_API_KEY` | API key for MCP auth in `apikey` mode, or optional fallback credential in `oauth` mode | — |
| `MCP_MAX_SESSIONS` | Maximum concurrent MCP sessions before LRU eviction | `100` |
| `MCP_EXTERNAL_PATH` | Path prefix behind reverse proxy (e.g. `/trackly-mcp`) | — |
| `MCP_ALLOWED_DOMAIN` | Restrict OAuth to a specific email domain | — |
| `MCP_CORS_ORIGIN` | Allowed browser origin for CORS. Unset means no CORS headers are emitted. | — |
| `MCP_MAX_REQUEST_BYTES` | Max HTTP request body size for `/mcp` and OAuth endpoints | `1048576` |
| `AZURE_TENANT_ID` | Azure Entra ID tenant (for OAuth) | — |
| `AZURE_CLIENT_ID` | Azure app registration client ID (for OAuth) | — |
| `AZURE_CLIENT_SECRET` | Azure app registration secret (for OAuth) | — |

## Quick Start

### Local (stdio mode)

```bash
npm install
npm run build
node dist/mcp-server.js
```

### Local (HTTP mode)

```bash
npm run build
MCP_HTTP_PORT=3000 MCP_AUTH_MODE=apikey MCP_API_KEY=my-secret node dist/mcp-server.js
# Health check: curl http://localhost:3000/health
# MCP endpoint: http://localhost:3000/mcp
```

### Docker

```bash
docker build -t trackly-mcp .
docker run -p 3000:3000 \
  -e MCP_HTTP_PORT=3000 \
  -e MCP_HOST=0.0.0.0 \
  -e KANBAN_PROJECT_URL=https://trackly-api.azurewebsites.net \
  -e TRACKLY_AUTH_MODE=apikey-login \
  -e TRACKLY_EMAIL=you@example.com \
  -e TRACKLY_API_KEY=... \
  -e MCP_AUTH_MODE=apikey \
  -e MCP_API_KEY=my-secret \
  trackly-mcp
```

### Docker Compose

```bash
# For the default compose settings, set MCP_API_KEY before starting.
docker compose up
```

## MCP Client Configuration

### Stdio mode (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "trackly-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "env": {
        "KANBAN_PROJECT_URL": "https://trackly-api.azurewebsites.net",
        "TRACKLY_AUTH_MODE": "apikey-login",
        "TRACKLY_EMAIL": "you@example.com",
        "TRACKLY_API_KEY": "..."
      }
    }
  }
}
```

### HTTP mode (remote server)

```json
{
  "mcpServers": {
    "trackly-mcp": {
      "type": "sse",
      "url": "https://mcp.dunavnet.eu/trackly-mcp/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}
```

If you prefer OAuth for remote clients, set `MCP_AUTH_MODE=oauth` and the Azure Entra ID variables. You can still keep `MCP_API_KEY` configured as an optional shared-secret fallback for clients that do not support the OAuth flow yet.

## Gateway Deployment

Trackly MCP is deployed at `mcp.dunavnet.eu/trackly-mcp/mcp` alongside the ProposalEngine MCP servers, behind a shared Caddy reverse-proxy gateway.

The gateway provides:
- **TLS termination** via Let's Encrypt (or Azure App Service managed certs)
- **Path-based routing**: `/trackly-mcp/*` → `trackly-mcp:3000`
- **Server discovery**: `GET /catalog` returns all available MCP servers
- **OAuth well-known endpoints**: RFC 9728 / 8414 compliant metadata discovery

Images are pushed to `dunavnet.azurecr.io/mcp/trackly-mcp` via the CD pipeline or manually with `scripts/push-to-acr.ps1` from the GrantAgent repo.

## Development

```bash
npm install
npm run typecheck   # Type-check without emitting
npm test            # Run tests
npm run build       # Compile to dist/
npm run dev         # Run in development mode (stdio)
```

## Troubleshooting

### Connection refused / timeout
- Ensure `MCP_HTTP_PORT` is set to enable HTTP mode
- In Docker or App Service multi-container deployments, set `MCP_HOST=0.0.0.0` so other containers can reach the MCP server
- Check the server is listening: `curl http://localhost:3000/health`
- Verify firewall/network rules if connecting remotely

### 401 Unauthorized
- In `apikey` mode: ensure `MCP_API_KEY` matches exactly (check for trailing spaces)
- In `oauth` mode: ensure Azure credentials are set and the token hasn't expired
- In `oauth` mode: `MCP_API_KEY` can also be used as a backward-compatible shared-secret fallback if configured
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

### Verify all required environment variables
```bash
node --input-type=module -e "import('./dist/transport.js').then(({validateStartup})=>{const r=validateStartup(process.env);if(!r.valid){console.error('ERRORS:');r.errors.forEach(e=>console.error(' ',e));process.exit(1)}console.log('All required env vars are set.');if(r.warnings.length){console.log('WARNINGS:');r.warnings.forEach(w=>console.log(' ',w))}})"
```

## Architecture

- **`src/mcp-server.ts`** — MCP server definition, tool handlers, entry point
- **`src/trackly-client.ts`** — Trackly API client with auth, retry, rate limiting, input sanitization
- **`src/transport.ts`** — Dual-mode transport (stdio/HTTP) with session management, startup validation, structured logging, and HTTP limits
- **`src/oauth.ts`** — OAuth 2.1 + Azure Entra ID (PKCE, JWT validation, dynamic registration)
- **`src/config.ts`** — Environment variable loading and startup validation
- **`src/http-utils.ts`** — Shared HTTP utilities (request body buffering, env parsing)
