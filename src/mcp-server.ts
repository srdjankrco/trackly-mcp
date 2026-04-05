import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import { loadConfig, validateConfig } from "./config.js";
import { TracklyClient, TracklyClientError } from "./trackly-client.js";
import { createLogger } from "./logger.js";
import { startServer, validateStartup } from "./transport.js";

const logger = createLogger("mcp-server");

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof TracklyClientError && error.status ? String(error.status) : 'ERR';
  const requestUrl = error instanceof TracklyClientError ? error.requestUrl : undefined;
  return {
    content: [{ type: "text" as const, text: requestUrl ? `[${code}] ${message}\nURL: ${requestUrl}` : `[${code}] ${message}` }],
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
    "- list_tasks(plan_id?, status?, assignee?, mine_only?, completed_in_last_days?)  plan_id accepts a project title or plan ID",
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
    version: packageInfo.version,
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

  server.tool(
    "list_projects",
    `List Trackly projects/plans available to the current user.

Example: list_projects({})`,
    {},
    async () => {
      try {
        const projects = await client.listProjects();
        return ok(JSON.stringify(projects, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_tasks",
    `List Trackly tasks, optionally filtered by plan, status, assignee, or mine-only.

Examples:
  list_tasks({})                                        all tasks
  list_tasks({ plan_id: "My Project" })                 filter by project
  list_tasks({ status: "In Progress" })                 filter by status
  list_tasks({ mine_only: true })                        tasks assigned to me
  list_tasks({ plan_id: "Sprint 5", status: "Done", completed_in_last_days: 7 })`,
    {
      plan_id: z.string().optional().describe("Trackly project title or plan ID."),
      status: z.string().optional().describe("Bucket/status name to filter by."),
      assignee: z.string().optional().describe("Assignee email, exact name, or user GUID."),
      mine_only: z.boolean().optional().describe("If true, filter to TRACKLY_EMAIL."),
      completed_in_last_days: z.number().int().positive().optional().describe("Pass through completedInLastDays."),
    },
    async ({ plan_id, status, assignee, mine_only, completed_in_last_days }) => {
      try {
        if (mine_only && assignee) {
          return fail(new Error("Specify either mine_only=true or assignee, not both."));
        }

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
    `Get full details for a Trackly task by ID.

Example: get_task({ task_id: "ABC-123" })`,
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
    `Create a Trackly task in a project/plan.

Examples:
  create_task({ title: "Fix login bug", plan_id: "Backend" })
  create_task({ title: "Review PR", description: "Review and approve #42", status: "In Review", priority: 2 })`,
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
        return ok(`Created task ${task.id} \"${task.title}\" in plan \"${task.planId}\".\n\n${JSON.stringify(task, null, 2)}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_task_status",
    `Move a Trackly task to another bucket/status.

Examples:
  update_task_status({ task_id: "ABC-123", status: "In Progress" })
  update_task_status({ task_id: "ABC-123", status: "Done", plan_id: "Sprint 5" })`,
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
    `Add a comment to a Trackly task.

Example: add_comment({ task_id: "ABC-123", comment: "Looks good, approved!" })`,
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
    `List comments on a Trackly task.

Example: list_comments({ task_id: "ABC-123" })`,
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
  // Validate environment before doing anything else.
  const { valid, errors, warnings } = validateStartup();
  for (const warning of warnings) {
    logger.warn('Startup warning', { warning });
  }
  if (!valid) {
    for (const error of errors) {
      logger.error('Startup error', { error });
    }
    process.exit(1);
  }

  // Trackly config (baseUrl, auth) is loaded and validated inside createTracklyServer -> createTracklyClient.
  await startServer(createTracklyServer, "trackly-mcp");
}

main().catch((error) => {
  logger.error('Fatal startup error', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});
