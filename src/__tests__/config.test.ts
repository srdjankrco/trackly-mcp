import { describe, it, expect } from "vitest";
import { loadConfig, validateConfig } from "../config.js";

describe("loadConfig", () => {
  it("returns defaults when no env vars are set", () => {
    const cfg = loadConfig({});
    expect(cfg.baseUrl).toBe("");
    expect(cfg.token).toBe("");
    expect(cfg.authMode).toBe("bearer");
    expect(cfg.projectId).toBeUndefined();
    expect(cfg.workspaceId).toBeUndefined();
    expect(cfg.email).toBeUndefined();
    expect(cfg.password).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.rateLimitMs).toBeUndefined();
    expect(cfg.maxRetries).toBeUndefined();
    expect(cfg.timeoutMs).toBeUndefined();
  });

  it("reads all env vars correctly", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://example.com",
      KANBAN_TOKEN: "tok-123",
      TRACKLY_PROJECT_ID: "proj-1",
      TRACKLY_WORKSPACE_ID: "ws-1",
      TRACKLY_AUTH_MODE: "apikey-login",
      TRACKLY_EMAIL: "user@example.com",
      TRACKLY_PASSWORD: "secret",
      TRACKLY_API_KEY: "key-abc",
      TRACKLY_RATE_LIMIT_MS: "200",
      TRACKLY_MAX_RETRIES: "5",
      TRACKLY_TIMEOUT_MS: "10000",
    });

    expect(cfg.baseUrl).toBe("https://example.com");
    expect(cfg.token).toBe("tok-123");
    expect(cfg.projectId).toBe("proj-1");
    expect(cfg.workspaceId).toBe("ws-1");
    expect(cfg.authMode).toBe("apikey-login");
    expect(cfg.email).toBe("user@example.com");
    expect(cfg.password).toBe("secret");
    expect(cfg.apiKey).toBe("key-abc");
    expect(cfg.rateLimitMs).toBe(200);
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.timeoutMs).toBe(10000);
  });

  it("defaults authMode to bearer", () => {
    const cfg = loadConfig({ KANBAN_PROJECT_URL: "https://x.com" });
    expect(cfg.authMode).toBe("bearer");
  });
});

describe("validateConfig", () => {
  it("throws when KANBAN_PROJECT_URL is missing", () => {
    const cfg = loadConfig({});
    expect(() => validateConfig(cfg)).toThrow("KANBAN_PROJECT_URL is required");
  });

  it("throws when apikey-login mode is missing TRACKLY_API_KEY", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "apikey-login",
      TRACKLY_EMAIL: "user@example.com",
    });
    expect(() => validateConfig(cfg)).toThrow("TRACKLY_API_KEY is required");
  });

  it("throws when apikey-login mode is missing TRACKLY_EMAIL", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "apikey-login",
      TRACKLY_API_KEY: "key-123",
    });
    expect(() => validateConfig(cfg)).toThrow("TRACKLY_EMAIL is required");
  });

  it("throws when password-login mode is missing TRACKLY_PASSWORD", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "password-login",
      TRACKLY_EMAIL: "user@example.com",
    });
    expect(() => validateConfig(cfg)).toThrow("TRACKLY_PASSWORD is required");
  });

  it("throws when password-login mode is missing TRACKLY_EMAIL", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "password-login",
      TRACKLY_PASSWORD: "secret",
    });
    expect(() => validateConfig(cfg)).toThrow("TRACKLY_EMAIL is required");
  });

  it("throws when bearer mode is missing KANBAN_TOKEN", () => {
    const cfg = loadConfig({ KANBAN_PROJECT_URL: "https://x.com", TRACKLY_AUTH_MODE: "bearer" });
    expect(() => validateConfig(cfg)).toThrow("KANBAN_TOKEN is required");
  });

  it("throws when TRACKLY_RATE_LIMIT_MS is invalid", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "bearer",
      KANBAN_TOKEN: "tok-123",
      TRACKLY_RATE_LIMIT_MS: "-1",
    });
    expect(() => validateConfig(cfg)).toThrow("TRACKLY_RATE_LIMIT_MS must be greater than or equal to 0.");
  });

  it("throws when TRACKLY_TIMEOUT_MS is not greater than zero", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "bearer",
      KANBAN_TOKEN: "tok-123",
      TRACKLY_TIMEOUT_MS: "0",
    });
    expect(() => validateConfig(cfg)).toThrow("TRACKLY_TIMEOUT_MS must be greater than 0.");
  });

  it("passes with valid apikey-login config", () => {
    const cfg = loadConfig({
      KANBAN_PROJECT_URL: "https://x.com",
      TRACKLY_AUTH_MODE: "apikey-login",
      TRACKLY_EMAIL: "user@example.com",
      TRACKLY_API_KEY: "key-123",
    });
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});
