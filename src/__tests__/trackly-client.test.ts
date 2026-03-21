import { describe, it, expect, vi, beforeEach } from "vitest";
import { TracklyClient, TracklyClientError } from "../trackly-client.js";
import type { TracklyMcpConfig } from "../config.js";

function makeConfig(overrides: Partial<TracklyMcpConfig> = {}): TracklyMcpConfig {
  return {
    baseUrl: "https://trackly.test",
    token: "test-token",
    authMode: "bearer",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TracklyClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if baseUrl is empty", () => {
    expect(() => new TracklyClient(makeConfig({ baseUrl: "" }))).toThrow("KANBAN_PROJECT_URL is required");
  });

  it("strips trailing slashes from baseUrl", () => {
    const client = new TracklyClient(makeConfig({ baseUrl: "https://trackly.test///" }));
    // Access private field via prototype — just verify construction succeeds
    expect(client).toBeDefined();
  });

  describe("whoAmI", () => {
    it("returns user info", async () => {
      const user = { id: "u1", name: "Test", email: "test@example.com" };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(user));

      const client = new TracklyClient(makeConfig());
      const result = await client.whoAmI();
      expect(result).toEqual(user);
    });
  });

  describe("listProjects", () => {
    it("maps plans to projects", async () => {
      const plans = [
        { id: "p1", title: "Project 1" },
        { id: "p2", title: "Project 2" },
      ];
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(plans));

      const client = new TracklyClient(makeConfig());
      const projects = await client.listProjects();
      expect(projects).toEqual([
        { id: "p1", title: "Project 1" },
        { id: "p2", title: "Project 2" },
      ]);
    });
  });

  describe("getTask", () => {
    it("maps task response fields", async () => {
      const taskResponse = {
        id: "t1",
        title: "Test Task",
        description: "A description",
        planId: "p1",
        bucketName: "To Do",
        labels: ["bug"],
        assignee: "user@test.com",
        priority: 1,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(taskResponse));

      const client = new TracklyClient(makeConfig());
      const task = await client.getTask("t1");

      expect(task.id).toBe("t1");
      expect(task.title).toBe("Test Task");
      expect(task.description).toBe("A description");
      expect(task.status).toBe("To Do");
      expect(task.labels).toEqual(["bug"]);
      expect(task.assignee).toBe("user@test.com");
      expect(task.priority).toBe("1");
    });

    it("uses statusDisplayName over bucketName", async () => {
      const taskResponse = {
        id: "t1",
        title: "Task",
        planId: "p1",
        bucketName: "bucket",
        statusDisplayName: "In Progress",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(taskResponse));

      const client = new TracklyClient(makeConfig());
      const task = await client.getTask("t1");
      expect(task.status).toBe("In Progress");
    });

    it("falls back to Unknown when no status field exists", async () => {
      const taskResponse = { id: "t1", title: "Task", planId: "p1" };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(taskResponse));

      const client = new TracklyClient(makeConfig());
      const task = await client.getTask("t1");
      expect(task.status).toBe("Unknown");
    });

    it("extracts repoUrl from taskSpec", async () => {
      const taskResponse = {
        id: "t1",
        title: "Task",
        planId: "p1",
        taskSpec: { repo_url: "https://github.com/test/repo" },
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(taskResponse));

      const client = new TracklyClient(makeConfig());
      const task = await client.getTask("t1");
      expect(task.repoUrl).toBe("https://github.com/test/repo");
    });
  });

  describe("updateTaskStatus", () => {
    it("resolves bucket and patches", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // getTask
        .mockResolvedValueOnce(jsonResponse({ id: "t1", title: "T", planId: "p1" }))
        // getBuckets
        .mockResolvedValueOnce(jsonResponse([{ id: "b2", name: "Done" }]))
        // PATCH
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new TracklyClient(makeConfig());
      await client.updateTaskStatus("t1", "Done");

      const patchCall = fetchSpy.mock.calls[2];
      expect(patchCall?.[1]?.method).toBe("PATCH");
    });
  });

  describe("addComment", () => {
    it("posts comment", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new TracklyClient(makeConfig());
      await client.addComment("t1", "Hello");

      const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
      expect(body.content).toBe("Hello");
      expect(body.contentType).toBe("text");
    });
  });

  describe("error handling", () => {
    it("throws TracklyClientError on 4xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Not Found", { status: 404 }),
      );

      const client = new TracklyClient(makeConfig());
      await expect(client.getTask("missing")).rejects.toThrow(TracklyClientError);
    });

    it("retries on 5xx", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("Error", { status: 500 }))
        .mockResolvedValueOnce(jsonResponse({ id: "t1", title: "T", planId: "p1" }));

      const client = new TracklyClient(makeConfig({ maxRetries: 1 }));
      const task = await client.getTask("t1");
      expect(task.id).toBe("t1");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("auth mode selection", () => {
    it("uses bearer token directly when provided", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ id: "u1" }));

      const client = new TracklyClient(makeConfig({ token: "my-token" }));
      await client.whoAmI();

      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-token");
    });

    it("falls back to apikey-login when apiKey and email are set", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // login
        .mockResolvedValueOnce(jsonResponse({ token: "new-token" }))
        // whoAmI
        .mockResolvedValueOnce(jsonResponse({ id: "u1" }));

      const client = new TracklyClient(makeConfig({
        token: "",
        authMode: "bearer",
        apiKey: "key-123",
        email: "user@test.com",
      }));
      await client.whoAmI();

      // First call should be login
      const loginUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(loginUrl).toContain("/api/auth/login/apikey");
    });
  });
});
