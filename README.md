# Trackly MCP

`trackly-mcp` is a standalone MCP server for working with Trackly projects, tasks, comments, and bucket/status updates.

It supports both **stdio** (local CLI) and **HTTP** (remote/Docker) transport modes, with optional OAuth 2.1 (Azure Entra ID) or API-key authentication.

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
| `TRACKLY_EMAIL` | User email (for `apikey-login` / `password-login`) | — |
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
| `TRACKLY_MAX_RETRIES` | Max retries on transient failures | `2` |
| `TRACKLY_TIMEOUT_MS` | HTTP request timeout (ms) | `30000` |

### MCP Transport & Auth

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_HTTP_PORT` | HTTP port (omit or `0` for stdio mode) | — |
| `MCP_AUTH_MODE` | MCP auth: `apikey` or `oauth` | `apikey` |
| `MCP_API_KEY` | API key for MCP auth (when `MCP_AUTH_MODE=apikey`) | — |
| `MCP_EXTERNAL_PATH` | Path prefix behind reverse proxy (e.g. `/trackly-mcp`) | — |
| `MCP_ALLOWED_DOMAIN` | Restrict OAuth to a specific email domain | — |
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
  -e KANBAN_PROJECT_URL=https://trackly-api.azurewebsites.net \
  -e TRACKLY_AUTH_MODE=apikey-login \
  -e TRACKLY_EMAIL=you@example.com \
  -e TRACKLY_API_KEY=... \
  trackly-mcp
```

### Docker Compose

```bash
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

## Architecture

- **`src/mcp-server.ts`** — MCP server definition, tool handlers, entry point
- **`src/trackly-client.ts`** — Trackly API client with auth, retry, rate limiting
- **`src/transport.ts`** — Dual-mode transport (stdio/HTTP) with session management
- **`src/oauth.ts`** — OAuth 2.1 + Azure Entra ID (PKCE, JWT validation, dynamic registration)
- **`src/config.ts`** — Environment variable loading and startup validation
- **`src/logger.ts`** — Structured JSON logger (stderr-only to protect stdio protocol)
