import type {
  CommandResult,
  SessionSummary,
  TaskSnapshot,
  UiCommand,
  UiEvent,
} from "../server/protocol.js";

export interface ProviderPresetView {
  id: string;
  displayName: string;
  protocol: string;
  defaultBaseUrl: string;
  keyRequired: boolean;
  keyLabel: string;
  modelList: string;
  note: string;
  docsUrl: string;
}

export interface ProviderKeyStatus {
  id: string;
  keyConfigured: boolean;
}

export interface DiscoveredModelView {
  id: string;
  displayName: string | null;
  ownedBy: string | null;
}

export type ModelsOutcome =
  | { ok: true; providerId: string; baseUrl: string; models: DiscoveredModelView[]; source: string }
  | { ok: false; providerId: string; baseUrl: string; kind: string; detail: string };

export type ConnectionOutcome =
  | { ok: true; providerId: string; baseUrl: string; kind: string; modelCount: number; detail: string }
  | { ok: false; providerId: string; baseUrl: string; kind: string; modelCount: number; detail: string };

export interface ProductConfigView {
  schemaVersion: number;
  defaultProviderId: string;
  defaultModel: string;
  defaultBaseUrl: string | null;
  customProviders: Array<{ displayName: string; baseUrl: string; keyRequired: boolean }>;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
}

export interface ApiClient {
  info(): Promise<{ workspace: string }>;
  sessions(): Promise<SessionSummary[]>;
  snapshot(taskId: string): Promise<TaskSnapshot>;
  toolDetail(taskId: string, attemptId: string): Promise<{ detail: string; truncated: boolean }>;
  command(command: UiCommand): Promise<CommandResult>;
  subscribe(taskId: string, onEvent: (event: UiEvent) => void, onStatus: (status: "live" | "dropped") => void): () => void;
  providers(): Promise<ProviderPresetView[]>;
  providerStatus(): Promise<ProviderKeyStatus[]>;
  removeProviderKey(providerId: string): Promise<{ removed: boolean }>;
  providerModels(providerId: string, baseUrl?: string | null): Promise<ModelsOutcome>;
  testProvider(providerId: string, baseUrl?: string | null): Promise<ConnectionOutcome>;
  productConfig(): Promise<ProductConfigView | null>;
  saveProductConfig(config: ProductConfigView): Promise<ProductConfigView>;
  browseWorkspace(relPath: string): Promise<WorkspaceEntry[]>;
  resolveWorkspace(path: string): Promise<{ path: string; displayName: string }>;
}

function newCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createCommandId(): string {
  return `cmd-${newCommandId().slice(0, 12)}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : `http ${response.status}`;
  } catch {
    return `http ${response.status}`;
  }
}

export function createApi(base: string): ApiClient {
  async function info(): Promise<{ workspace: string }> {
    const response = await fetch(`${base}/api/info`);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as { workspace: string };
  }

  async function sessions(): Promise<SessionSummary[]> {
    const response = await fetch(`${base}/api/sessions`);
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { sessions: SessionSummary[] };
    return body.sessions;
  }

  async function snapshot(taskId: string): Promise<TaskSnapshot> {
    const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/snapshot`);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as TaskSnapshot;
  }

  async function toolDetail(taskId: string, attemptId: string): Promise<{ detail: string; truncated: boolean }> {
    const response = await fetch(
      `${base}/api/tasks/${encodeURIComponent(taskId)}/tool?id=${encodeURIComponent(attemptId)}`,
    );
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as { detail: string; truncated: boolean };
  }

  async function command(command: UiCommand): Promise<CommandResult> {
    const response = await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as CommandResult;
  }

  async function providers(): Promise<ProviderPresetView[]> {
    const response = await fetch(`${base}/api/providers`);
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { providers: ProviderPresetView[] };
    return body.providers;
  }

  async function providerStatus(): Promise<ProviderKeyStatus[]> {
    const response = await fetch(`${base}/api/providers/status`);
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { status: ProviderKeyStatus[] };
    return body.status;
  }

  async function removeProviderKey(providerId: string): Promise<{ removed: boolean }> {
    const response = await fetch(`${base}/api/providers/key?provider=${encodeURIComponent(providerId)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as { removed: boolean };
  }

  async function providerModels(providerId: string, baseUrl?: string | null): Promise<ModelsOutcome> {
    const response = await fetch(`${base}/api/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, ...(baseUrl !== undefined && baseUrl !== null ? { baseUrl } : {}) }),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as ModelsOutcome;
  }

  async function testProvider(providerId: string, baseUrl?: string | null): Promise<ConnectionOutcome> {
    const response = await fetch(`${base}/api/providers/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, ...(baseUrl !== undefined && baseUrl !== null ? { baseUrl } : {}) }),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as ConnectionOutcome;
  }

  async function productConfig(): Promise<ProductConfigView | null> {
    const response = await fetch(`${base}/api/product-config`);
    if (response.status === 503) return null;
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { config: ProductConfigView };
    return body.config;
  }

  async function saveProductConfig(config: ProductConfigView): Promise<ProductConfigView> {
    const response = await fetch(`${base}/api/product-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { config: ProductConfigView };
    return body.config;
  }

  async function browseWorkspace(relPath: string): Promise<WorkspaceEntry[]> {
    const response = await fetch(`${base}/api/workspace/browse?path=${encodeURIComponent(relPath)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { entries: WorkspaceEntry[] };
    return body.entries;
  }

  async function resolveWorkspace(path: string): Promise<{ path: string; displayName: string }> {
    const response = await fetch(`${base}/api/workspace/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as { path: string; displayName: string };
  }

  function subscribe(
    taskId: string,
    onEvent: (event: UiEvent) => void,
    onStatus: (status: "live" | "dropped") => void,
  ): () => void {
    let stopped = false;
    let source: EventSource | null = null;
    // EventSource re-sends Last-Event-ID on reconnect; the server replays
    // missed frames or answers with a resync event.
    const url = `${base}/api/tasks/${encodeURIComponent(taskId)}/events`;
    const connect = (): void => {
      if (stopped) return;
      source = new EventSource(url);
      source.onmessage = (message: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(message.data) as UiEvent);
        } catch {
          // A malformed frame never corrupts state; resync recovers.
          onStatus("dropped");
        }
      };
      source.onerror = () => {
        onStatus("dropped");
        source?.close();
        if (!stopped) window.setTimeout(connect, 2000);
      };
      source.onopen = () => { onStatus("live"); };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
    };
  }

  return {
    info,
    sessions,
    snapshot,
    toolDetail,
    command,
    subscribe,
    providers,
    providerStatus,
    removeProviderKey,
    providerModels,
    testProvider,
    productConfig,
    saveProductConfig,
    browseWorkspace,
    resolveWorkspace,
  };
}
