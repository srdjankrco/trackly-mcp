import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

describe("transport HTTP mode", () => {
  beforeAll(async () => {
    process.env["MCP_HTTP_PORT"] = String(TEST_PORT);
    process.env["MCP_AUTH_MODE"] = "apikey";
    process.env["MCP_API_KEY"] = "test-secret";

    const { startServer } = await import("../transport.js");
    const factory = () => new McpServer({ name: "test-server", version: "0.0.1" });

    // startServer blocks forever in HTTP mode — fire and forget.
    void startServer(factory, "test");

    // Wait for the server to bind.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(() => {
    delete process.env["MCP_HTTP_PORT"];
    delete process.env["MCP_AUTH_MODE"];
    delete process.env["MCP_API_KEY"];
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

  it("returns CORS headers on OPTIONS /mcp", async () => {
    const res = await httpRequest(TEST_PORT, "/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("Mcp-Session-Id");
  });
});
