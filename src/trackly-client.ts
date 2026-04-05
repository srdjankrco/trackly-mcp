import type { TracklyAuthMode, TracklyMcpConfig } from "./config.js";

/* ------------------------------------------------------------------ */
/*  Input sanitization                                                   */
/* ------------------------------------------------------------------ */

const MAX_STRING_LENGTH = 10_000;
const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/g;
const LOOKUP_CACHE_TTL_MS = 60_000;

function sanitizeString(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(CONTROL_CHAR_REGEX, '')
    .trim()
    .slice(0, MAX_STRING_LENGTH);
}

export interface TracklyProject {
  id: string;
  title: string;
}

export interface TracklyTask {
  id: string;
  title: string;
  description: string;
  status: string;
  planId: string;
  labels: string[];
  assignee: string | null;
  priority: string | null;
  repoUrl?: string;
  url: string;
  raw: Record<string, unknown>;
}

export interface TracklyComment {
  content: string;
  createdAt?: string;
}

interface TracklyTaskResponse {
  id: string;
  title: string;
  description?: string;
  planId: string;
  bucketName?: string;
  mappedStatus?: string;
  statusDisplayName?: string;
  labels?: string[];
  assignee?: string;
  assignees?: string[];
  priority?: number;
  repoUrl?: string;
  repositoryUrl?: string;
}

interface TracklyBucket {
  id: string;
  name: string;
}

interface TracklyUser {
  id: string;
  name?: string;
  email?: string;
}

interface TracklyAuthResponse {
  token: string;
}

interface TracklyCommentResponse {
  content?: string;
  text?: string;
  createdAt?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TracklyClientError extends Error {
  public readonly status?: number;
  public readonly requestUrl?: string;

  constructor(message: string, status?: number, requestUrl?: string) {
    super(message);
    this.name = "TracklyClientError";
    this.status = status;
    this.requestUrl = requestUrl;
  }
}

export class TracklyClient {
  private accessToken: string | null;
  private readonly baseUrl: string;
  private readonly rateLimitMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;
  private projectCache: CacheEntry<TracklyProject[]> | null = null;
  private organizationUsersCache: CacheEntry<TracklyUser[]> | null = null;
  private whoAmICache: CacheEntry<TracklyUser> | null = null;
  private readonly bucketCache = new Map<string, CacheEntry<TracklyBucket[]>>();

  constructor(private readonly config: TracklyMcpConfig) {
    if (!config.baseUrl) {
      throw new TracklyClientError("KANBAN_PROJECT_URL is required.");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.accessToken = config.token || null;
    this.rateLimitMs = config.rateLimitMs ?? 0;
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  async whoAmI(): Promise<{ id: string; name?: string; email?: string }> {
    const cached = this.getCachedValue(this.whoAmICache);
    if (cached) {
      return cached;
    }

    const me = await this.tracklyRequest<TracklyUser>("/api/auth/me");
    this.whoAmICache = this.makeCacheEntry(me);
    return me;
  }

  async listProjects(): Promise<TracklyProject[]> {
    const cached = this.getCachedValue(this.projectCache);
    if (cached) {
      return cached;
    }

    const plans = await this.tracklyRequest<Array<{ id: string; title: string }>>("/api/planner/plans");
    const projects = plans.map((plan) => ({ id: plan.id, title: plan.title }));
    this.projectCache = this.makeCacheEntry(projects);
    return projects;
  }

  async listTasks(filters: {
    planId?: string;
    status?: string;
    assignee?: string;
    completedInLastDays?: number;
  } = {}): Promise<TracklyTask[]> {
    const query = new URLSearchParams();
    const planId = filters.planId ? await this.resolvePlanId(filters.planId) : this.getPlanId();
    if (planId) {
      query.set("planId", planId);
    }
    if (filters.assignee) {
      query.set("assignedTo", await this.resolveAssigneeFilter(filters.assignee));
    }
    if (typeof filters.completedInLastDays === "number") {
      query.set("completedInLastDays", String(filters.completedInLastDays));
    }
    if (filters.status && planId) {
      const bucketId = await this.resolveBucketIdByStatus(planId, filters.status);
      if (bucketId) {
        query.set("bucketId", bucketId);
      }
    }

    const tasks = await this.tracklyRequest<TracklyTaskResponse[]>(
      `/api/planner/tasks${query.toString() ? `?${query.toString()}` : ""}`,
    );
    return tasks.map((task) => this.mapTask(task));
  }

  async getTask(taskId: string): Promise<TracklyTask> {
    const task = await this.tracklyRequest<TracklyTaskResponse>(`/api/planner/tasks/${encodeURIComponent(taskId)}`);
    return this.mapTask(task);
  }

  async createTask(input: {
    title: string;
    description?: string;
    planId?: string;
    status?: string;
    priority?: number;
  }): Promise<TracklyTask> {
    const planId = input.planId ? await this.resolvePlanId(input.planId) : this.getPlanId();
    if (!planId) {
      throw new TracklyClientError("TRACKLY_PROJECT_ID or planId is required to create a task.");
    }

    const payload: Record<string, unknown> = {
      title: sanitizeString(input.title),
      description: sanitizeString(input.description ?? ""),
      planId,
    };

    if (typeof input.priority === "number") {
      payload.priority = input.priority;
    }

    if (input.status) {
      const bucketId = await this.resolveBucketIdByStatus(planId, input.status);
      if (bucketId) {
        payload.bucketId = bucketId;
      }
    }

    const task = await this.tracklyRequest<TracklyTaskResponse>("/api/planner/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return this.mapTask(task);
  }

  async updateTaskStatus(taskId: string, status: string, planId?: string): Promise<void> {
    if (!planId) {
      const task = await this.tracklyRequest<TracklyTaskResponse>(`/api/planner/tasks/${encodeURIComponent(taskId)}`);
      planId = task.planId ?? this.getPlanId();
    }
    if (!planId) {
      throw new TracklyClientError(`Cannot update status for task "${taskId}" without a plan ID.`);
    }

    const bucketId = await this.resolveBucketIdByStatus(planId, status);
    if (!bucketId) {
      throw new TracklyClientError(`No bucket found for status "${status}" in plan "${planId}".`);
    }

    await this.tracklyRequestVoid(`/api/planner/tasks/${encodeURIComponent(taskId)}/bucket`, {
      method: "PATCH",
      body: JSON.stringify({ bucketId }),
    });
  }

  async addComment(taskId: string, comment: string): Promise<void> {
    await this.tracklyRequestVoid(`/api/planner/tasks/${encodeURIComponent(taskId)}/comments`, {
      method: "POST",
      body: JSON.stringify({
        content: sanitizeString(comment),
        contentType: "text",
      }),
    });
  }

  async listComments(taskId: string): Promise<TracklyComment[]> {
    const comments = await this.tracklyRequest<TracklyCommentResponse[]>(
      `/api/planner/tasks/${encodeURIComponent(taskId)}/comments`,
    );
    return comments.map((comment) => ({
      content: comment.content ?? comment.text ?? "",
      createdAt: comment.createdAt,
    }));
  }

  private async tracklyRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.ensureAccessToken();
    return this.requestJson<T>(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async tracklyRequestVoid(path: string, init: RequestInit = {}): Promise<void> {
    const token = await this.ensureAccessToken();
    await this.requestVoid(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    const authMode: TracklyAuthMode = this.config.authMode ?? "bearer";

    if (authMode === "bearer") {
      throw new TracklyClientError("Trackly bearer mode requires KANBAN_TOKEN.");
    }

    if (!this.config.email) {
      throw new TracklyClientError(`Trackly ${authMode} requires TRACKLY_EMAIL.`);
    }

    if (authMode === "password-login") {
      if (!this.config.password) {
        throw new TracklyClientError("Trackly password-login requires TRACKLY_PASSWORD.");
      }
      const login = await this.requestJson<TracklyAuthResponse>(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: this.config.email,
          password: this.config.password,
        }),
      });
      this.accessToken = login.token;
      this.clearLookupCaches();
      return login.token;
    }

    if (!this.config.apiKey) {
      throw new TracklyClientError("Trackly apikey-login requires TRACKLY_API_KEY.");
    }

    const login = await this.requestJson<TracklyAuthResponse>(`${this.baseUrl}/api/auth/login/apikey`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify({ email: this.config.email }),
    });
    this.accessToken = login.token;
    this.clearLookupCaches();
    return login.token;
  }

  private async resolvePlanId(nameOrId: string): Promise<string> {
    const plans = await this.listProjects();
    const normalized = nameOrId.trim().toLowerCase();
    const matched = plans.find((plan) => plan.id === nameOrId || plan.title.toLowerCase() === normalized);
    if (!matched) {
      throw new TracklyClientError(`Trackly project "${nameOrId}" not found.`);
    }
    return matched.id;
  }

  private async resolveBucketIdByStatus(planId: string, status: string): Promise<string | null> {
    const buckets = await this.getBuckets(planId);
    const normalizedTarget = normalizeStatus(status);
    const matched = buckets.find((bucket) => normalizeStatus(bucket.name) === normalizedTarget);
    return matched?.id ?? null;
  }

  private async resolveAssigneeFilter(rawAssignee: string): Promise<string> {
    const assignee = rawAssignee.trim();
    if (isGuid(assignee)) {
      return assignee;
    }

    const users = await this.getOrganizationUsers();
    const normalized = assignee.toLowerCase();
    const matched = users.find((user) => {
      const email = user.email?.toLowerCase();
      const name = user.name?.toLowerCase();
      return email === normalized || name === normalized;
    });

    if (matched?.id) {
      return matched.id;
    }

    const me = await this.whoAmI();
    if (me.email?.toLowerCase() === normalized || me.name?.toLowerCase() === normalized) {
      return me.id;
    }

    throw new TracklyClientError(`Trackly assignee "${rawAssignee}" not found.`);
  }

  private mapTask(task: TracklyTaskResponse): TracklyTask {
    const taskSpec = (task as unknown as Record<string, unknown>)["taskSpec"] as Record<string, unknown> | undefined;
    const repoUrl =
      task.repoUrl ??
      task.repositoryUrl ??
      (typeof taskSpec?.["repo_url"] === "string" ? taskSpec["repo_url"] : undefined);

    return {
      id: task.id,
      title: task.title,
      description: task.description ?? "",
      status: task.statusDisplayName ?? task.mappedStatus ?? task.bucketName ?? "Unknown",
      planId: task.planId,
      labels: task.labels ?? [],
      assignee: task.assignee ?? task.assignees?.[0] ?? null,
      priority: typeof task.priority === "number" ? String(task.priority) : null,
      repoUrl,
      url: `${this.baseUrl}/api/planner/tasks/${encodeURIComponent(task.id)}`,
      raw: task as unknown as Record<string, unknown>,
    };
  }

  private getPlanId(): string | undefined {
    return this.config.projectId ?? this.config.workspaceId;
  }

  private async requestJson<T>(url: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
    const response = await this.request(url, init, allowRetry);
    const text = await response.text();
    if (!text) {
      throw new TracklyClientError(`Empty response body from ${url}`, response.status, url);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TracklyClientError(`Invalid JSON response from ${url}: ${text.slice(0, 200)}`, response.status, url);
    }
  }

  private async requestVoid(url: string, init: RequestInit = {}, allowRetry = true): Promise<void> {
    await this.request(url, init, allowRetry);
  }

  private async request(url: string, init: RequestInit = {}, allowRetry = true): Promise<Response> {
    await this.applyRateLimit();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        this.lastRequestAt = Date.now();
        return response;
      }

      // Only retry on transient failures: 5xx, 429 (rate limit), or network errors.
      // Permanent failures (4xx except 429) are thrown immediately.
      const isRetryable =
        response.status === 429 ||
        response.status >= 500 ||
        response.status === 0; // network error (e.g. DNS, timeout)

      if (!isRetryable) {
        throw new TracklyClientError(`Request failed with status ${response.status} for ${url}`, response.status, url);
      }

      if (!allowRetry) {
        throw new TracklyClientError(`Request failed after retries with status ${response.status} for ${url}`, response.status, url);
      }

      return this.requestWithRetry(url, init, response.status);
    } catch (error) {
      if (error instanceof TracklyClientError) {
        throw error;
      }
      if (!allowRetry) {
        throw new TracklyClientError(`Request failed for ${url}: ${String(error)}`, undefined, url);
      }
      return this.requestWithRetry(url, init);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestWithRetry(url: string, init: RequestInit, firstStatus?: number): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this.sleep(this.getBackoffMs(attempt, firstStatus));
      const response = await this.request(url, init, false);
      if (response.ok) {
        return response;
      }
    }
    throw new TracklyClientError(`Request failed after ${this.maxRetries} retries for ${url}.`);
  }

  private getBackoffMs(attempt: number, status?: number): number {
    const base = status === 429 ? 500 : 300;
    const exponential = base * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.3 * exponential; // 0–30% jitter to prevent thundering herd
    return Math.floor(exponential + jitter);
  }

  private async applyRateLimit(): Promise<void> {
    if (this.rateLimitMs <= 0 || this.lastRequestAt === 0) {
      return;
    }
    const elapsed = Date.now() - this.lastRequestAt;
    const waitMs = this.rateLimitMs - elapsed;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private makeCacheEntry<T>(value: T): CacheEntry<T> {
    return {
      value,
      expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
    };
  }

  private getCachedValue<T>(entry: CacheEntry<T> | null): T | null {
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      return null;
    }

    return entry.value;
  }

  private clearLookupCaches(): void {
    this.projectCache = null;
    this.organizationUsersCache = null;
    this.whoAmICache = null;
    this.bucketCache.clear();
  }

  private async getBuckets(planId: string): Promise<TracklyBucket[]> {
    const cached = this.bucketCache.get(planId);
    const cachedBuckets = cached && this.getCachedValue(cached);
    if (cachedBuckets) {
      return cachedBuckets;
    }

    const buckets = await this.tracklyRequest<TracklyBucket[]>(
      `/api/planner/buckets?planId=${encodeURIComponent(planId)}`,
    );
    this.bucketCache.set(planId, this.makeCacheEntry(buckets));
    return buckets;
  }

  private async getOrganizationUsers(): Promise<TracklyUser[]> {
    const cached = this.getCachedValue(this.organizationUsersCache);
    if (cached) {
      return cached;
    }

    const users = await this.tracklyRequest<TracklyUser[]>("/api/auth/organization-users");
    this.organizationUsersCache = this.makeCacheEntry(users);
    return users;
  }
}

function normalizeStatus(input: string): string {
  return input.replace(/\s+/g, "").toLowerCase();
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
