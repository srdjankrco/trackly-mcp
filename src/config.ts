export type TracklyAuthMode = "bearer" | "password-login" | "apikey-login";

export interface TracklyMcpConfig {
  baseUrl: string;
  token: string;
  projectId?: string;
  workspaceId?: string;
  authMode: TracklyAuthMode;
  email?: string;
  password?: string;
  apiKey?: string;
  rateLimitMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TracklyMcpConfig {
  return {
    baseUrl: env["KANBAN_PROJECT_URL"] ?? "",
    token: env["KANBAN_TOKEN"] ?? "",
    projectId: env["TRACKLY_PROJECT_ID"],
    workspaceId: env["TRACKLY_WORKSPACE_ID"],
    authMode: (env["TRACKLY_AUTH_MODE"] as TracklyAuthMode | undefined) ?? "bearer",
    email: env["TRACKLY_EMAIL"],
    password: env["TRACKLY_PASSWORD"],
    apiKey: env["TRACKLY_API_KEY"],
    rateLimitMs: env["TRACKLY_RATE_LIMIT_MS"] ? Number(env["TRACKLY_RATE_LIMIT_MS"]) : undefined,
    maxRetries: env["TRACKLY_MAX_RETRIES"] ? Number(env["TRACKLY_MAX_RETRIES"]) : undefined,
    timeoutMs: env["TRACKLY_TIMEOUT_MS"] ? Number(env["TRACKLY_TIMEOUT_MS"]) : undefined,
  };
}
