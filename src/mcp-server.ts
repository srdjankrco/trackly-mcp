import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, validateConfig } from "./config.js";
import { TracklyClient } from "./trackly-client.js";
import { startServer } from "./transport.js";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function howtoText(): string {
  return [
    "Trackly MCP exposes raw Trackly operations.",
    "",
    "Tools:",
    "- whoami",
    "- list_projects",
    "- list_tasks(plan_id?, status?, assignee?, mine_only?, completed_in_last_days?)",
    "- get_task(task_id)",
    "- create_task(title, description?, plan_id?, status?, priority?)",
    "- update_task_status(task_id, status, plan_id?)",
    "- add_comment(task_id, comment)",
    "- list_comments(task_id)",
    "",
    "Transport:",
    "- Stdio (default): set no MCP_HTTP_PORT",
    "- HTTP: set MCP_HTTP_PORT=3000 → serves at /mcp",
    "",
    "MCP Auth (HTTP mode):",
    "- MCP_AUTH_MODE=apikey + MCP_API_KEY (Bearer token)",
    "- MCP_AUTH_MODE=oauth (Azure Entra ID)",
    "",
    "Required env:",
    "- KANBAN_PROJECT_URL",
    "- TRACKLY_AUTH_MODE (bearer | password-login | apikey-login)",
    "- TRACKLY_EMAIL",
    "- KANBAN_TOKEN or TRACKLY_PASSWORD or TRACKLY_API_KEY",
  ].join("\n");
}

function createTracklyServer(): McpServer {
  const server = new McpServer({
    name: "trackly-mcp",
    version: "0.1.0",
  });

  const cfg = loadConfig();
  validateConfig(cfg);
  const client = new TracklyClient(cfg);

  server.tool("trackly-howto", "Show quick usage for Trackly MCP.", {}, async () => ok(howtoText()));

  server.tool("whoami", "Return the current Trackly user.", {}, async () => {
    try {
      const me = await client.whoAmI();
      return ok(JSON.stringify(me, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  server.tool("list_projects", "List Trackly projects/plans available to the current user.", {}, async () => {
    try {
      const projects = await client.listProjects();
      return ok(JSON.stringify(projects, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  server.tool(
    "list_tasks",
    "List Trackly tasks, optionally filtered by plan, status, assignee, or mine-only.",
    {
      plan_id: z.string().optional().describe("Trackly project title or plan ID."),
      status: z.string().optional().describe("Bucket/status name to filter by."),
      assignee: z.string().optional().describe("Assignee email, exact name, or user GUID."),
      mine_only: z.boolean().optional().describe("If true, filter to TRACKLY_EMAIL."),
      completed_in_last_days: z.number().int().positive().optional().describe("Pass through completedInLastDays."),
    },
    async ({ plan_id, status, assignee, mine_only, completed_in_last_days }) => {
      try {
        const tasks = await client.listTasks({
          planId: plan_id,
          status,
          assignee: mine_only ? cfg.email : assignee,
          completedInLastDays: completed_in_last_days,
        });
        return ok(JSON.stringify(tasks, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_task",
    "Get full details for a Trackly task by ID.",
    {
      task_id: z.string().describe("Trackly task/card ID."),
    },
    async ({ task_id }) => {
      try {
        const task = await client.getTask(task_id);
        return ok(JSON.stringify(task, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_task",
    "Create a Trackly task in a project/plan.",
    {
      title: z.string().describe("Task title."),
      description: z.string().optional().describe("Task description."),
      plan_id: z.string().optional().describe("Trackly project title or plan ID."),
      status: z.string().optional().describe("Initial Trackly status/bucket name."),
      priority: z.number().int().optional().describe("Numeric Trackly priority."),
    },
    async ({ title, description, plan_id, status, priority }) => {
      try {
        const task = await client.createTask({
          title,
          description,
          planId: plan_id,
          status,
          priority,
        });
        return ok(JSON.stringify(task, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_task_status",
    "Move a Trackly task to another bucket/status.",
    {
      task_id: z.string().describe("Trackly task/card ID."),
      status: z.string().describe("Target Trackly bucket/status name."),
      plan_id: z.string().optional().describe("Plan ID (skips extra fetch if provided)."),
    },
    async ({ task_id, status, plan_id }) => {
      try {
        await client.updateTaskStatus(task_id, status, plan_id);
        return ok(`Updated task ${task_id} to status "${status}".`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "add_comment",
    "Add a comment to a Trackly task.",
    {
      task_id: z.string().describe("Trackly task/card ID."),
      comment: z.string().describe("Comment text."),
    },
    async ({ task_id, comment }) => {
      try {
        await client.addComment(task_id, comment);
        return ok(`Added comment to task ${task_id}.`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_comments",
    "List comments on a Trackly task.",
    {
      task_id: z.string().describe("Trackly task/card ID."),
    },
    async ({ task_id }) => {
      try {
        const comments = await client.listComments(task_id);
        return ok(JSON.stringify(comments, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  await startServer(createTracklyServer, "trackly-mcp");
}

main().catch((error) => {
  console.error(`[trackly-mcp] fatal:`, error);
  process.exit(1);
});
