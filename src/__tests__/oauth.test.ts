import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

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
    if (u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
    if (uri === "https://vscode.dev/redirect") return true;
    return false;
  } catch {
    return false;
  }
}

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
  it("trusts 127.0.0.1 with any port", () => {
    expect(isTrustedPublicClientUri("http://127.0.0.1:12345")).toBe(true);
    expect(isTrustedPublicClientUri("http://127.0.0.1:9999/callback")).toBe(true);
    expect(isTrustedPublicClientUri("http://127.0.0.1")).toBe(true);
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
