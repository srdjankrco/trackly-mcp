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

export function validateConfig(cfg: TracklyMcpConfig): void {
  if (!cfg.baseUrl) throw new Error('KANBAN_PROJECT_URL is required');
  if (cfg.authMode === 'apikey-login' && !cfg.apiKey)
    throw new Error('TRACKLY_API_KEY is required when TRACKLY_AUTH_MODE=apikey-login');
  if (cfg.authMode === 'password-login' && !cfg.password)
    throw new Error('TRACKLY_PASSWORD is required when TRACKLY_AUTH_MODE=password-login');
  if (cfg.authMode === 'bearer' && !cfg.token)
    throw new Error('KANBAN_TOKEN is required when TRACKLY_AUTH_MODE=bearer');
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
