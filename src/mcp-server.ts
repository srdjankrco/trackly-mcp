import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { TracklyClient, TracklyClientError } from "./trackly-client.js";

const log = createLogger("trackly-mcp");

function createClient(): TracklyClient {
  return new TracklyClient(loadConfig());
}

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
    "- update_task_status(task_id, status)",
    "- add_comment(task_id, comment)",
    "- list_comments(task_id)",
    "",
    "Required env:",
    "- KANBAN_PROJECT_URL",
    "- TRACKLY_AUTH_MODE",
    "- TRACKLY_EMAIL",
    "- KANBAN_TOKEN or TRACKLY_PASSWORD or TRACKLY_API_KEY",
  ].join("\n");
}

function createTracklyServer(): McpServer {
  const server = new McpServer({
    name: "trackly-mcp",
    version: "0.1.0",
  });

  server.tool("trackly-howto", "Show quick usage for Trackly MCP.", {}, async () => ok(howtoText()));

  server.tool("whoami", "Return the current Trackly user.", {}, async () => {
    try {
      const me = await createClient().whoAmI();
      return ok(JSON.stringify(me, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  server.tool("list_projects", "List Trackly projects/plans available to the current user.", {}, async () => {
    try {
      const projects = await createClient().listProjects();
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
        const cfg = loadConfig();
        const tasks = await createClient().listTasks({
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
        const task = await createClient().getTask(task_id);
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
        const task = await createClient().createTask({
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
    },
    async ({ task_id, status }) => {
      try {
        await createClient().updateTaskStatus(task_id, status);
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
        await createClient().addComment(task_id, comment);
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
        const comments = await createClient().listComments(task_id);
        return ok(JSON.stringify(comments, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createTracklyServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Trackly MCP started on stdio");
}

main().catch((error) => {
  const message = error instanceof TracklyClientError ? error.message : (error instanceof Error ? error.stack : String(error));
  console.error(`[trackly-mcp] fatal: ${message}`);
  process.exit(1);
});
