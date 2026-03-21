# Trackly MCP

`trackly-mcp` is a standalone MCP server for working with Trackly projects, tasks, comments, and bucket/status updates.

It was extracted from the Trackly-specific connector logic that currently also lives inside `trackly-speckit`, so it can become the dedicated raw Trackly MCP surface while Speckit focuses on orchestration.

## Tools

- `trackly-howto`
- `whoami`
- `list_projects`
- `list_tasks`
- `get_task`
- `create_task`
- `update_task_status`
- `add_comment`
- `list_comments`

## Required environment

- `KANBAN_PROJECT_URL`
- `TRACKLY_AUTH_MODE`
- `TRACKLY_EMAIL`
- one of:
  - `KANBAN_TOKEN` for `bearer`
  - `TRACKLY_PASSWORD` for `password-login`
  - `TRACKLY_API_KEY` for `apikey-login`

Optional:

- `TRACKLY_PROJECT_ID`
- `TRACKLY_WORKSPACE_ID`
- `LOG_LEVEL`

## Local usage

```bash
npm install
npm run build
npm run dev
```

## MCP config example

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

## Extraction note

This repo is the new standalone home for the Trackly MCP layer. A follow-up change in `trackly-speckit` should switch its Trackly integration to consume this package or reuse this server externally.
