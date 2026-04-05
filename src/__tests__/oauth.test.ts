import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import { handleOAuthRoute } from "../oauth.js";
import { RequestBodyTooLargeError } from "../http-utils.js";

// The oauth module's functions are not exported directly, so we test
// the pure logic that we can extract. For PKCE and trusted URI checks,
// we replicate the exact logic from oauth.ts to verify correctness.

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") {
    const computed = createHash("sha256").update(verifier).digest("base64url");
    return computed === challenge;
  }
  return false;
}

function isTrustedPublicClientUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && u.hostname === "127.0.0.1") {
      const port = parseInt(u.port, 10);
      const inRange = !isNaN(port) && port >= 1024 && port <= 65535;
      return inRange;
    }
    if (uri === "https://vscode.dev/redirect") return true;
    return false;
  } catch {
    return false;
  }
}

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
        res.on("data", (chunk) => chunks.push(chunk));
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

const TEST_PORT = 20400 + Math.floor(Math.random() * 500);
const ORIGINAL_ENV = {
  MCP_MAX_REQUEST_BYTES: process.env["MCP_MAX_REQUEST_BYTES"],
  AZURE_TENANT_ID: process.env["AZURE_TENANT_ID"],
  AZURE_CLIENT_ID: process.env["AZURE_CLIENT_ID"],
  AZURE_CLIENT_SECRET: process.env["AZURE_CLIENT_SECRET"],
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

let server: http.Server;

describe("PKCE verification", () => {
  it("accepts valid S256 challenge", () => {
    const verifier = "test-code-verifier-string";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPKCE(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects wrong verifier", () => {
    const verifier = "correct-verifier";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPKCE("wrong-verifier", challenge, "S256")).toBe(false);
  });

  it("rejects plain method", () => {
    expect(verifyPKCE("verifier", "verifier", "plain")).toBe(false);
  });

  it("rejects empty method", () => {
    expect(verifyPKCE("verifier", "verifier", "")).toBe(false);
  });
});

describe("trusted public client URIs", () => {
  it("trusts 127.0.0.1 with ephemeral ports (1024-65535)", () => {
    expect(isTrustedPublicClientUri("http://127.0.0.1:12345")).toBe(true);
    expect(isTrustedPublicClientUri("http://127.0.0.1:9999/callback")).toBe(true);
    expect(isTrustedPublicClientUri("http://127.0.0.1:1024")).toBe(true);
    expect(isTrustedPublicClientUri("http://127.0.0.1:65535")).toBe(true);
  });

  it("rejects 127.0.0.1 with privileged ports (< 1024)", () => {
    expect(isTrustedPublicClientUri("http://127.0.0.1:80")).toBe(false);
    expect(isTrustedPublicClientUri("http://127.0.0.1:443")).toBe(false);
    expect(isTrustedPublicClientUri("http://127.0.0.1:22")).toBe(false);
  });

  it("rejects 127.0.0.1 with no port (edge case)", () => {
    // No port means the default port for the scheme, not ephemeral
    expect(isTrustedPublicClientUri("http://127.0.0.1")).toBe(false);
  });

  it("trusts vscode.dev redirect", () => {
    expect(isTrustedPublicClientUri("https://vscode.dev/redirect")).toBe(true);
  });

  it("rejects localhost (not 127.0.0.1)", () => {
    expect(isTrustedPublicClientUri("http://localhost:3000")).toBe(false);
  });

  it("rejects HTTPS on 127.0.0.1", () => {
    expect(isTrustedPublicClientUri("https://127.0.0.1:3000")).toBe(false);
  });

  it("rejects arbitrary URLs", () => {
    expect(isTrustedPublicClientUri("https://evil.com/redirect")).toBe(false);
    expect(isTrustedPublicClientUri("https://vscode.dev/other")).toBe(false);
  });

  it("rejects invalid URIs", () => {
    expect(isTrustedPublicClientUri("not-a-url")).toBe(false);
  });
});

describe("OAuth HTTP routes", () => {
  beforeAll(async () => {
    process.env["AZURE_TENANT_ID"] = "tenant-id";
    process.env["AZURE_CLIENT_ID"] = "client-id";
    process.env["AZURE_CLIENT_SECRET"] = "client-secret";
    process.env["MCP_MAX_REQUEST_BYTES"] = "128";

    server = http.createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
        const handled = await handleOAuthRoute(req, res, pathname);
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
        }
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, "127.0.0.1", resolve);
    });
  });

  afterAll(async () => {
    restoreEnv();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("rejects oversized registration payloads", async () => {
    const res = await httpRequest(TEST_PORT, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:3000"],
        client_name: "x".repeat(512),
      }),
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "payload_too_large" });
  });

  it("rejects oversized token payloads", async () => {
    const res = await httpRequest(TEST_PORT, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${"x".repeat(512)}&code_verifier=verifier&client_id=test-client`,
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "payload_too_large" });
  });

  it("rejects invalid redirect URIs at client registration time", async () => {
    const res = await httpRequest(TEST_PORT, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["not-a-url"],
        client_name: "bad-client",
      }),
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "invalid_client_metadata",
      error_description: "redirect_uris must contain valid http or https URLs.",
    });
  });

  it("rejects expired authorization state", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    try {
      const authorizeRes = await httpRequest(
        TEST_PORT,
        "/authorize?client_id=test-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000&code_challenge=test-challenge&code_challenge_method=S256&state=client-state",
      );

      expect(authorizeRes.status).toBe(302);
      const location = authorizeRes.headers.location;
      expect(location).toBeTruthy();
      const state = new URL(location as string).searchParams.get("state");
      expect(state).toBeTruthy();

      nowSpy.mockReturnValue(1_000 + (10 * 60 * 1000) + 1);

      const callbackRes = await httpRequest(
        TEST_PORT,
        `/callback?code=azure-code&state=${encodeURIComponent(state as string)}`,
      );

      expect(callbackRes.status).toBe(400);
      expect(JSON.parse(callbackRes.body)).toEqual({
        error: "invalid_request",
        error_description: "Authorization request expired. Please try again.",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
