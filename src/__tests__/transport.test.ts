import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as oauth from "../oauth.js";

// Helper: make an HTTP request and return { status, body, headers }
async function httpRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Use a single server for all tests to avoid port conflicts and cleanup issues.
const TEST_PORT = 19200 + Math.floor(Math.random() * 800);
const OAUTH_TEST_PORT = TEST_PORT + 1;

const ORIGINAL_ENV = {
  MCP_HTTP_PORT: process.env["MCP_HTTP_PORT"],
  MCP_AUTH_MODE: process.env["MCP_AUTH_MODE"],
  MCP_API_KEY: process.env["MCP_API_KEY"],
  MCP_MAX_REQUEST_BYTES: process.env["MCP_MAX_REQUEST_BYTES"],
  AZURE_TENANT_ID: process.env["AZURE_TENANT_ID"],
  AZURE_CLIENT_ID: process.env["AZURE_CLIENT_ID"],
  AZURE_CLIENT_SECRET: process.env["AZURE_CLIENT_SECRET"],
};

function restoreEnv(env: typeof ORIGINAL_ENV): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function startHttpTestServer(
  port: number,
  authMode: "apikey" | "oauth",
  overrides: Record<string, string | undefined> = {},
): Promise<void> {
  const previousEnv = {
    MCP_HTTP_PORT: process.env["MCP_HTTP_PORT"],
    MCP_AUTH_MODE: process.env["MCP_AUTH_MODE"],
    MCP_API_KEY: process.env["MCP_API_KEY"],
    MCP_MAX_REQUEST_BYTES: process.env["MCP_MAX_REQUEST_BYTES"],
    AZURE_TENANT_ID: process.env["AZURE_TENANT_ID"],
    AZURE_CLIENT_ID: process.env["AZURE_CLIENT_ID"],
    AZURE_CLIENT_SECRET: process.env["AZURE_CLIENT_SECRET"],
  };

  process.env["MCP_HTTP_PORT"] = String(port);
  process.env["MCP_AUTH_MODE"] = authMode;
  process.env["MCP_API_KEY"] = "test-secret";
  process.env["MCP_MAX_REQUEST_BYTES"] = "1048576";
  process.env["AZURE_TENANT_ID"] = "tenant-id";
  process.env["AZURE_CLIENT_ID"] = "client-id";
  process.env["AZURE_CLIENT_SECRET"] = "client-secret";

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    const { startServer } = await import("../transport.js");
    const factory = () => new McpServer({ name: "test-server", version: "0.0.1" });

    // startServer blocks forever in HTTP mode — fire and forget.
    void startServer(factory, `test-${authMode}-${port}`);

    // Wait for the server to bind.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    restoreEnv(previousEnv);
  }
}

describe("transport HTTP mode", () => {
  beforeAll(async () => {
    await startHttpTestServer(TEST_PORT, "apikey");
  });

  afterAll(() => {
    restoreEnv(ORIGINAL_ENV);
  });

  it("returns health check response", async () => {
    const res = await httpRequest(TEST_PORT, "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(typeof body.sessions).toBe("number");
  });

  it("returns root info at /", async () => {
    const res = await httpRequest(TEST_PORT, "/");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.endpoint).toBe("/mcp");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await httpRequest(TEST_PORT, "/unknown");
    expect(res.status).toBe(404);
  });

  it("fails fast when HTTP apikey mode is configured without MCP_API_KEY", async () => {
    const previousEnv = {
      MCP_HTTP_PORT: process.env["MCP_HTTP_PORT"],
      MCP_AUTH_MODE: process.env["MCP_AUTH_MODE"],
      MCP_API_KEY: process.env["MCP_API_KEY"],
      MCP_MAX_REQUEST_BYTES: process.env["MCP_MAX_REQUEST_BYTES"],
      AZURE_TENANT_ID: process.env["AZURE_TENANT_ID"],
      AZURE_CLIENT_ID: process.env["AZURE_CLIENT_ID"],
      AZURE_CLIENT_SECRET: process.env["AZURE_CLIENT_SECRET"],
    };

    process.env["MCP_HTTP_PORT"] = String(TEST_PORT + 20);
    process.env["MCP_AUTH_MODE"] = "apikey";
    delete process.env["MCP_API_KEY"];

    try {
      const { startServer } = await import("../transport.js");
      const factory = () => new McpServer({ name: "test-server", version: "0.0.1" });
      await expect(startServer(factory, "missing-key")).rejects.toThrow("MCP_API_KEY is required");
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("rejects wrong API key", async () => {
    const res = await httpRequest(TEST_PORT, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("allows correct API key and initializes", async () => {
    const res = await httpRequest(TEST_PORT, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("allows the shared API key as fallback in oauth mode", async () => {
    const validateSpy = vi.spyOn(oauth, "validateAccessToken").mockResolvedValue(false);

    try {
      await startHttpTestServer(OAUTH_TEST_PORT, "oauth");

      const res = await httpRequest(OAUTH_TEST_PORT, "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.1" },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(validateSpy).not.toHaveBeenCalled();
    } finally {
      validateSpy.mockRestore();
    }
  });

  it("returns CORS headers on OPTIONS /mcp", async () => {
    const res = await httpRequest(TEST_PORT, "/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
  });

  it("emits CORS headers only when MCP_CORS_ORIGIN is configured", async () => {
    const corsPort = TEST_PORT + 3;
    await startHttpTestServer(corsPort, "apikey", {
      MCP_CORS_ORIGIN: "https://example.com",
    });

    const res = await httpRequest(corsPort, "/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("Mcp-Session-Id");
  });

  it("rejects oversized initialize payloads", async () => {
    const limitedPort = TEST_PORT + 2;
    await startHttpTestServer(limitedPort, "apikey", {
      MCP_MAX_REQUEST_BYTES: "128",
    });

    const res = await httpRequest(limitedPort, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "test",
            version: "0.0.1",
            padding: "x".repeat(512),
          },
        },
      }),
    });

    expect(res.status).toBe(413);
  });
});

describe("validateStartup", () => {
  it("returns errors when KANBAN_PROJECT_URL is missing", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("KANBAN_PROJECT_URL is required");
  });

  it("returns errors when HTTP mode is enabled without MCP_API_KEY in apikey mode", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({
      KANBAN_PROJECT_URL: "https://trackly.test",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_MODE: "apikey",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MCP_API_KEY is required when MCP_HTTP_PORT is set with MCP_AUTH_MODE=apikey");
  });

  it("returns errors when OAuth mode is enabled without Azure credentials", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({
      KANBAN_PROJECT_URL: "https://trackly.test",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_MODE: "oauth",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("AZURE_TENANT_ID"))).toBe(true);
  });

  it("warns when MCP_CORS_ORIGIN is set to *", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({
      KANBAN_PROJECT_URL: "https://trackly.test",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_MODE: "apikey",
      MCP_API_KEY: "secret",
      MCP_CORS_ORIGIN: "*",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("MCP_CORS_ORIGIN=*"))).toBe(true);
  });

  it("warns when MCP_HOST is not set in HTTP mode", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({
      KANBAN_PROJECT_URL: "https://trackly.test",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_MODE: "apikey",
      MCP_API_KEY: "secret",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("MCP_HOST"))).toBe(true);
  });

  it("passes when all required variables are provided", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({
      KANBAN_PROJECT_URL: "https://trackly.test",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_MODE: "apikey",
      MCP_API_KEY: "secret",
      MCP_HOST: "127.0.0.1",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not warn about MCP_HOST by default in oauth mode", async () => {
    const { validateStartup } = await import("../transport.js");
    const result = validateStartup({
      KANBAN_PROJECT_URL: "https://trackly.test",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_MODE: "oauth",
      AZURE_TENANT_ID: "tenant-id",
      AZURE_CLIENT_ID: "client-id",
      AZURE_CLIENT_SECRET: "client-secret",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("MCP_HOST"))).toBe(false);
  });
});

describe("HTTP method validation", () => {
  it("returns 405 with Allow header for unsupported methods", async () => {
    const res = await httpRequest(TEST_PORT, "/mcp", {
      method: "PUT",
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, POST, DELETE, OPTIONS");
  });

  it("returns 405 for PATCH method", async () => {
    const res = await httpRequest(TEST_PORT, "/mcp", {
      method: "PATCH",
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(405);
  });
});

describe("health endpoint diagnostics", () => {
  it("includes sessions, maxSessions, uptime, and memoryMB", async () => {
    const res = await httpRequest(TEST_PORT, "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("sessions");
    expect(body).toHaveProperty("maxSessions");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("memoryMB");
    expect(typeof body.maxSessions).toBe("number");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.memoryMB).toBe("number");
  });
});
