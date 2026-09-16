import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type {
  ApiClient,
  ConnectionOutcome,
  DiscoveredModelView,
  ModelsOutcome,
  ProductConfigView,
  ProviderPresetView,
  WorkspaceEntry,
} from "./api.js";
import { createCommandId } from "./api.js";
import { unifiedDiff } from "./diff.js";
import { taskActivity, taskStateDescription, toolSummaryPreview } from "./presentation.js";
import { stateLabel, toolStatusLabel, type UiAction, type UiState, type UiView } from "./state.js";
import type {
  MessageView,
  SteeringView,
  TaskSnapshot,
  ToolActivityView,
  VerificationView,
} from "../server/protocol.js";

export interface Dispatch {
  (action: UiAction): void;
}

interface HeaderProps {
  api: ApiClient;
  state: UiState;
}

interface SidebarProps {
  state: UiState;
  dispatch: Dispatch;
}

interface ChatProps {
  state: UiState;
  dispatch: Dispatch;
}

interface DetailProps {
  api: ApiClient;
  state: UiState;
  dispatch: Dispatch;
}

interface ComposerProps {
  api: ApiClient;
  state: UiState;
  dispatch: Dispatch;
}

interface NewTaskProps {
  api: ApiClient;
  state: UiState;
  dispatch: Dispatch;
}

interface SettingsProps {
  api: ApiClient;
  state: UiState;
  dispatch: Dispatch;
}

const DEFAULT_MODEL_KEY = "lattice.defaultModel";
const DEFAULT_BASE_URL_KEY = "lattice.defaultBaseUrl";
const SEND_ON_ENTER_KEY = "lattice.sendOnEnter";
const FALLBACK_BASE_URL = "http://127.0.0.1:8080/v1";

export interface StringStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function localStore(): StringStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadModelDefaults(): { model: string; baseUrl: string } {
  try {
    return {
      model: window.localStorage.getItem(DEFAULT_MODEL_KEY) ?? "",
      baseUrl: window.localStorage.getItem(DEFAULT_BASE_URL_KEY) ?? FALLBACK_BASE_URL,
    };
  } catch {
    return { model: "", baseUrl: FALLBACK_BASE_URL };
  }
}

export function saveModelDefaults(model: string, baseUrl: string): void {
  try {
    window.localStorage.setItem(DEFAULT_MODEL_KEY, model);
    window.localStorage.setItem(DEFAULT_BASE_URL_KEY, baseUrl);
  } catch {
    // Preferências locais indisponíveis; a sessão atual continua funcionando.
  }
}

export interface UiModelDefaults {
  providerId: string;
  model: string;
  baseUrl: string | null;
}

/**
 * Device-global defaults: server product config wins; browser storage is
 * only a fallback for servers without the S5 config surface.
 */
export async function loadUiDefaults(api: ApiClient): Promise<UiModelDefaults> {
  try {
    const config = await api.productConfig();
    if (config !== null) {
      return { providerId: config.defaultProviderId, model: config.defaultModel, baseUrl: config.defaultBaseUrl };
    }
  } catch {
    // Sem config no servidor: cai para o fallback local abaixo.
  }
  // Fallback local: só aplica endpoint explícito do usuário; o fallback de
  // desenvolvimento nunca vira default silencioso (o preset define o padrão).
  let storedBase: string | null = null;
  try {
    storedBase = window.localStorage.getItem(DEFAULT_BASE_URL_KEY);
  } catch {
    storedBase = null;
  }
  const legacy = loadModelDefaults();
  return { providerId: "openai", model: legacy.model, baseUrl: storedBase };
}

/** Persists defaults device-wide when possible. Returns where they landed. */
export async function saveUiDefaults(api: ApiClient, defaults: UiModelDefaults): Promise<"server" | "browser"> {
  try {
    const current = await api.productConfig();
    if (current !== null) {
      await api.saveProductConfig({ ...current, defaultProviderId: defaults.providerId, defaultModel: defaults.model, defaultBaseUrl: defaults.baseUrl });
      return "server";
    }
  } catch {
    // Sem config no servidor: cai para o fallback local abaixo.
  }
  saveModelDefaults(defaults.model, defaults.baseUrl ?? "");
  return "browser";
}

// Enter envia a mensagem, salvo preferência explícita em contrário. Ausência
// de valor mantém o comportamento atual (enviar com Enter).
export function sendOnEnterEnabled(store?: StringStore | null): boolean {
  try {
    const storage = store === undefined ? localStore() : store;
    return storage?.getItem(SEND_ON_ENTER_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSendOnEnter(enabled: boolean, store?: StringStore | null): void {
  try {
    const storage = store === undefined ? localStore() : store;
    storage?.setItem(SEND_ON_ENTER_KEY, enabled ? "1" : "0");
  } catch {
    // Preferência local indisponível; a sessão atual continua funcionando.
  }
}

function composerKeyAction(event: KeyboardEvent, composing: boolean): "send" | null {
  if (event.key !== "Enter" || composing) return null;
  const native = event.nativeEvent as unknown as { isComposing?: boolean };
  if (native.isComposing === true) return null;
  if (event.ctrlKey || event.metaKey) return "send";
  if (!event.shiftKey && sendOnEnterEnabled()) return "send";
  return null;
}

function sendHint(): string {
  return sendOnEnterEnabled() ? "Enter envia · Shift+Enter quebra linha" : "Ctrl+Enter envia · Enter quebra linha";
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function shortTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "--:--";
  const date = new Date(parsed);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;
}

function stateClass(state: string): string {
  return `state state-${state.toLowerCase().replace("_", "-")}`;
}

function connectionLabel(state: UiState): string {
  switch (state.connection) {
    case "live":
      return "Runtime conectado";
    case "reconnecting":
      return "Reconectando";
    case "error":
      return state.error ?? "Erro de conexão";
    case "loading":
      return "Abrindo sessão";
  }
}

function UsageRing({ reserved, granted }: { reserved: number; granted: number }): JSX.Element {
  const ratio = granted > 0 ? Math.min(1, reserved / granted) : 0;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const label = `Contexto usado: ${formatTokens(reserved)} de ${formatTokens(granted)}`;
  return (
    <span className="usagering" title={label} role="img" aria-label={label}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="2.5" className="ring-track" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="ring-value"
          strokeDasharray={`${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="usage-text">{formatTokens(reserved)}/{formatTokens(granted)}</span>
    </span>
  );
}

export function Header({ api, state }: HeaderProps): JSX.Element {
  const task = state.task;
  const [configOpen, setConfigOpen] = useState(false);
  // Initialized from the task route when the dialog opens (single source of
  // truth: the route's provider/model). The useState default is only the
  // pre-open placeholder; openConfig syncs it to the live route below.
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const configWasOpenRef = useRef(false);
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (configOpen) {
      configWasOpenRef.current = true;
      // Sync the dialog's provider/model fields to the live task route every
      // time it opens (PR1-002): the route is the single source of truth, so
      // a task created under openrouter never offers an openai-preselected
      // key slot. User edits after opening are preserved (no sync while open).
      const route = taskRef.current;
      if (route !== null) {
        setProvider(route.provider);
        setModel(route.model);
      }
      const first = panelRef.current?.querySelector("input, select");
      if (first instanceof HTMLElement) first.focus();
    } else if (configWasOpenRef.current) {
      configWasOpenRef.current = false;
      modelButtonRef.current?.focus();
    }
  }, [configOpen]);

  async function applyModel(): Promise<void> {
    if (task === null || model.trim() === "") return;
    const commandId = createCommandId();
    setNotice("Troca de modelo enviada; aguardando o core aplicar.");
    try {
      const result = await api.command({
        commandId,
        kind: "select-model",
        taskId: task.taskId,
        payload: { provider, model: model.trim(), ...(baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : { baseUrl: null }) },
      });
      if (!result.accepted) {
        setNotice(`Troca não aplicada (${result.reason}). Interrompa a tarefa ou configure a credencial.`);
      } else {
        setNotice("Troca aceita; vale a partir do próximo ponto seguro.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "falha ao trocar de modelo");
    }
  }

  async function saveKey(): Promise<void> {
    if (key.trim() === "") return;
    try {
      // Single source of truth: the task route's provider selects the key
      // slot. The Header never invents its own provider universe (R1 F-0006:
      // the hardcoded "openai" slot is gone); Settings stays configuration.
      await api.command({ commandId: createCommandId(), kind: "set-key", payload: { provider, key } });
      setKey("");
      setNotice("Chave recebida pelo servidor local (só em memória, nunca exibida de novo).");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "falha ao salvar a chave");
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-main">
        <span className="appname">Lattice Agent</span>
        {task !== null ? (
          <>
            <span className="crumb" title={task.workspace}>{task.workspace.split("/").pop() ?? task.workspace}</span>
            <span className="crumb-separator" aria-hidden="true">/</span>
            <span className="taskname" title={task.objective}>{task.objective}</span>
            <span className={stateClass(task.state)} role="status">{stateLabel(task.state)}</span>
          </>
        ) : (
          <span className="taskname idle">Abrindo tarefa</span>
        )}
      </div>
      <div className="topbar-side">
        {task !== null && (
          <span className="budgettag" title="Chamadas e tokens liquidados e reservados dentro da concessão da tarefa">
            <span>{task.budget.settledCalls + task.budget.reservedCalls}/{task.budget.grantedCalls}</span> chamadas
            <span className="budget-separator" aria-hidden="true">·</span>
            <span>{formatTokens(task.budget.settledTokens + task.budget.reservedTokens)}/{formatTokens(task.budget.grantedTokens)}</span> tokens
          </span>
        )}
        {task !== null && (
          <span className="contexttag" title="Uso de contexto informado pelo core">
            {task.contextUsage.known ? (
              <UsageRing reserved={task.contextUsage.reservedTokens} granted={task.contextUsage.grantedTokens} />
            ) : (
              "contexto desconhecido"
            )}
          </span>
        )}
        {task !== null && (
          <div className="modelwrap">
            <button
              type="button"
              ref={modelButtonRef}
              className="btn model-button"
              aria-expanded={configOpen}
              aria-controls="model-config"
              aria-haspopup="dialog"
              aria-label={`Configurar modelo. Seleção atual ${task.provider}/${task.model}`}
              onClick={() => { setConfigOpen((open) => !open); }}
            >
              <span>{task.provider}/{task.model}</span>
              <span className="disclosure" aria-hidden="true">⌄</span>
            </button>
            {configOpen && (
              <div
                className="modelconfig"
                id="model-config"
                role="dialog"
                aria-label="Configuração do modelo"
                ref={panelRef}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setConfigOpen(false);
                  }
                }}
              >
                <div className="modelconfig-head">
                  <div>
                    <strong>Configuração do modelo</strong>
                    <span>Mudanças aplicadas pelo runtime em ponto seguro.</span>
                  </div>
                  <button type="button" className="btn icon" aria-label="Fechar configuração do modelo" onClick={() => { setConfigOpen(false); }}>×</button>
                </div>
                <label>
                  Provedor
                  <select value={provider} onChange={(event) => { setProvider(event.target.value); }} aria-label="Provedor">
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="gemini">Google AI Studio</option>
                    <option value="abacus">Abacus RouteLLM</option>
                    <option value="local">Local</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label>
                  Modelo
                  <input value={model} onChange={(event) => { setModel(event.target.value); }} placeholder={task.model} aria-label="Modelo" />
                </label>
                <label>
                  URL base
                  <input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); }} placeholder="http://127.0.0.1:8080/v1" aria-label="URL base" />
                </label>
                <div className="modelconfig-action">
                  <button type="button" className="btn primary" disabled={model.trim() === ""} onClick={() => { void applyModel(); }}>Aplicar modelo</button>
                </div>
                <div className="config-separator" />
                <label>
                  Chave de API <span>{task.keyConfigured ? "configurada" : "não configurada"}</span>
                  <input type="password" value={key} onChange={(event) => { setKey(event.target.value); }} autoComplete="off" aria-label="Chave de API" />
                </label>
                <div className="modelconfig-action">
                  <button type="button" className="btn" disabled={key.trim() === ""} onClick={() => { void saveKey(); }}>Salvar em memória</button>
                </div>
                {notice !== "" && <p className="notice" role="status">{notice}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function UiIcon({ name }: { name: "task" | "settings" | "help" | "search" | "folder" | "terminal" }): JSX.Element {
  const paths = {
    task: "M4 4h16v12H8l-4 4V4Z M8 8h8 M8 12h5",
    settings: "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01",
    search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    folder: "M3 6h7l2 2h9v12H3V6Z",
    terminal: "m5 7 5 5-5 5 M13 17h6",
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const NAV_ITEMS: Array<{ view: UiView; label: string; glyph: "task" | "settings" | "help" }> = [
  { view: "task", label: "Tarefas", glyph: "task" },
  { view: "settings", label: "Configurações", glyph: "settings" },
  { view: "help", label: "Ajuda", glyph: "help" },
];

export function Sidebar({ state, dispatch }: SidebarProps): JSX.Element {
  const collapsed = !state.sidebarOpen;
  const filter = state.sessionFilter.trim().toLowerCase();
  const visibleSessions = filter === ""
    ? state.sessions
    : state.sessions.filter((session) =>
      session.objective.toLowerCase().includes(filter) || stateLabel(session.state).toLowerCase().includes(filter),
    );

  function openTask(taskId: string): void {
    dispatch({ type: "open-task", taskId });
    dispatch({ type: "set-view", view: "task" });
  }

  function newTask(): void {
    dispatch({ type: "clear-task" });
    dispatch({ type: "set-view", view: "task" });
    window.requestAnimationFrame(() => { document.getElementById("new-task-objective")?.focus(); });
  }

  return (
    <nav className={collapsed ? "sidebar collapsed" : "sidebar"} aria-label="Navegação do harness">
      <div className="railhead">
        {!collapsed && (
          <span className="brandlabel" title="Lattice Agent">
            <span className="brandmark" aria-hidden="true" />
            Lattice <span className="brandtag">AGENT</span>
          </span>
        )}
        {collapsed && <span className="brandmark" aria-hidden="true" title="Lattice Agent" />}
        <button type="button" className="btn icon rail-toggle" aria-label={collapsed ? "Abrir navegação" : "Recolher navegação"} onClick={() => { dispatch({ type: "toggle-sidebar" }); }}>
          {collapsed ? "›" : "‹"}
        </button>
      </div>
      {!collapsed && state.task !== null && (
        <p className="railws" title={state.task.workspace}>{state.task.workspace}</p>
      )}
      {!collapsed && (
        <button type="button" className="btn newtaskbtn" onClick={newTask}>
          <span aria-hidden="true">+</span> Nova tarefa
        </button>
      )}
      {collapsed && (
        <button type="button" className="btn icon rail-action" aria-label="Nova tarefa" title="Nova tarefa" onClick={newTask}>
          +
        </button>
      )}
      {!collapsed && (
        <>
          <div className="sidebar-search">
            <UiIcon name="search" />
            <input
              value={state.sessionFilter}
              onChange={(event) => { dispatch({ type: "session-filter", filter: event.target.value }); }}
              placeholder="Buscar sessões"
              aria-label="Buscar sessões"
            />
          </div>
          <div className="sidebar-head">
            <span>Sessões</span>
            <span>{filter === "" ? state.sessions.length : `${visibleSessions.length}/${state.sessions.length}`}</span>
          </div>
          <ul className="sessionlist">
            {visibleSessions.map((session) => (
              <li key={session.taskId}>
                <button
                  type="button"
                  className={session.taskId === state.activeTaskId ? "session active" : "session"}
                  onClick={() => { openTask(session.taskId); }}
                  aria-current={session.taskId === state.activeTaskId}
                >
                  <span className="session-objective">{session.objective === "" ? "(tarefa sem título)" : session.objective}</span>
                  <span className="session-meta">
                    <span className={`session-state session-state-${session.state.toLowerCase().replace("_", "-")}`} aria-hidden="true" />
                    {stateLabel(session.state)}
                    <span aria-hidden="true">·</span>
                    <time dateTime={session.updatedAt}>{session.updatedAt.slice(0, 16).replace("T", " ")}</time>
                  </span>
                </button>
              </li>
            ))}
            {visibleSessions.length === 0 && (
              <li className="empty">{state.sessions.length === 0 ? "Nenhuma sessão ainda" : "Nenhuma sessão corresponde à busca"}</li>
            )}
          </ul>
          <div className="sidebar-foot">
            <p className={`connfoot ${state.connection}`} role="status">
              <span className="dot" aria-hidden="true" />
              {connectionLabel(state)}
            </p>
            <div className="sidebar-nav" role="group" aria-label="Navegação do produto">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.view}
                  type="button"
                  className={state.view === item.view ? "navitem active" : "navitem"}
                  aria-current={state.view === item.view}
                  onClick={() => { dispatch({ type: "set-view", view: item.view }); }}
                >
                  <span className="navglyph"><UiIcon name={item.glyph} /></span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {collapsed && (
        <div className="sidebar-foot">
          <div className="sidebar-nav" role="group" aria-label="Navegação do produto">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.view}
                type="button"
                className={state.view === item.view ? "navitem active" : "navitem"}
                aria-current={state.view === item.view}
                aria-label={item.label}
                title={item.label}
                onClick={() => { dispatch({ type: "set-view", view: item.view }); }}
              >
                <span className="navglyph"><UiIcon name={item.glyph} /></span>
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

function ToolRow({ tool, onOpen, open }: { tool: ToolActivityView; onOpen: () => void; open: boolean }): JSX.Element {
  const summary = toolSummaryPreview(tool, 180);
  return (
    <div className={tool.status === "failed" ? "toolrow failed" : open ? "toolrow selected" : "toolrow"}>
      <button
        type="button"
        className="toolrow-head"
        aria-expanded={open}
        aria-controls={open ? "tool-detail" : undefined}
        onClick={onOpen}
        aria-label={`${tool.tool} ${toolStatusLabel(tool.status)}${tool.target !== null ? ` ${tool.target}` : ""}`}
      >
        <span className="tooltime">{shortTime(tool.recordedAt)}</span>
        <span className={`statusmark statusmark-${tool.status}`} aria-hidden="true" />
        <span className="tool-main">
          <span className="tool-identity">
            <span className="toolname">{tool.tool}</span>
            {tool.target !== null && <span className="tooltarget" title={tool.target}>{tool.target}</span>}
          </span>
          <span className="toolsummary">{summary.text}</span>
        </span>
        {tool.durationMs !== null && <span className="tooldur">{formatDuration(tool.durationMs)}</span>}
        <span className={`toolstatus ${tool.status}`}>{toolStatusLabel(tool.status)}</span>
        <span className="row-disclosure" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
    </div>
  );
}

function MessageRow({ message }: { message: MessageView }): JSX.Element {
  const author = message.author === "user" ? "Você" : message.author === "agent" ? "Agente" : "Runtime";
  return (
    <article className={`message-row ${message.author}`}>
      <time className="eventtime" dateTime={message.recordedAt}>{shortTime(message.recordedAt)}</time>
      <div className="message-content">
        <span className="author">{author}</span>
        <p className="text">{message.text}</p>
      </div>
    </article>
  );
}

function VerificationRow({ verification }: { verification: VerificationView }): JSX.Element {
  const outcome = verification.exitCode === null
    ? "resultado incerto"
    : verification.exitCode === 0
      ? "passou"
      : `falhou com saída ${verification.exitCode}`;
  return (
    <div className="verification-row">
      <time className="eventtime" dateTime={verification.recordedAt}>{shortTime(verification.recordedAt)}</time>
      <span className={`statusmark ${verification.exitCode === 0 ? "statusmark-completed" : "statusmark-failed"}`} aria-hidden="true" />
      <div className="verification-main">
        <span className="verification-label">verificação</span>
        <code title={verification.command}>{verification.command}</code>
        <span className="verification-counts">
          {verification.countsKnown
            ? `${verification.passed ?? 0} passou · ${verification.failed ?? 0} falhou · ${verification.skipped ?? 0} ignorados`
            : "contagem não identificada"}
        </span>
      </div>
      <span className="verification-outcome">{outcome}</span>
    </div>
  );
}

function SteeringRow({ steering }: { steering: SteeringView }): JSX.Element {
  // R1 honesty (F-0004): free-text steering — guide AND forbid — is guidance
  // recorded durably and shown to the model, never mechanical enforcement.
  // Only typed hard restrictions (a future core surface) enforce. The label
  // says so explicitly so "applied" is never read as "blocked".
  const modeLabel = steering.mode === "forbid" ? "Restrição registrada · orientação" : "Orientação";
  return (
    <div className="steering-row">
      <time className="eventtime" dateTime={steering.recordedAt}>{shortTime(steering.recordedAt)}</time>
      <span className="statusmark statusmark-steering" aria-hidden="true" />
      <div className="steering-main">
        <span>{modeLabel} · {steering.state}</span>
        <p>{steering.text}</p>
        {steering.mode === "forbid" && (
          <p className="meta">Registrada como orientação forte; bloqueio mecânico exige restrição tipada (futura).</p>
        )}
      </div>
      <span className="steering-revision">rev {steering.appliedRevision ?? steering.expectedRevision}</span>
    </div>
  );
}

function TaskNotices({ task }: { task: TaskSnapshot }): JSX.Element | null {
  const description = taskStateDescription(task);
  if (description === "" && task.waits.length === 0 && task.unknowns === 0 && task.resumeBlockers.length === 0) return null;
  return (
    <section className={`task-notices task-notices-${task.state.toLowerCase().replace("_", "-")}`} aria-label="Estado da execução">
      {description !== "" && (
        <div className="task-notice-primary">
          <span className={stateClass(task.state)}>{stateLabel(task.state)}</span>
          <p>{description}</p>
        </div>
      )}
      {task.waits.map((wait) => (
        <div key={wait.waitId} className="notice-row" role="status">
          <span>Aguardando</span>
          <p>
            <strong>{wait.condition}</strong>
            <span>{wait.obligation} · Mantenha o Lattice Agent em execução para wake automático.</span>
          </p>
          <code>{wait.kind}</code>
        </div>
      ))}
      {task.unknowns > 0 && (
        <div className="notice-row uncertain-row">
          <span>Efeitos incertos</span>
          <p>{task.unknowns} {task.unknowns === 1 ? "efeito exige" : "efeitos exigem"} reconciliação antes de repetir.</p>
        </div>
      )}
      {task.unknownHistory.map((unknown) => (
        <div key={unknown.attemptId} className="notice-row uncertain-row">
          <span>Efeito incerto</span>
          <p>{unknown.operation}{unknown.target !== null ? ` ${unknown.target}` : ""}: {unknown.reason}</p>
          <code>{unknown.attemptId}</code>
        </div>
      ))}
      {task.resumeBlockers.map((blocker, index) => (
        <div key={`${index}-${blocker}`} className="notice-row">
          <span>Bloqueio de retomada</span>
          <p>{blocker}</p>
        </div>
      ))}
    </section>
  );
}

export function Chat({ state, dispatch }: ChatProps): JSX.Element {
  const chatRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const task = state.task;
  const activity = task === null ? [] : taskActivity(task);

  useEffect(() => {
    if (following) bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [following, task?.cut]);

  if (task === null) return <div className="chat" aria-live="off" />;
  return (
    <div className="chat-frame">
      <div
        ref={chatRef}
        className="chat"
        aria-label="Atividade da tarefa"
        onScroll={() => {
          const node = chatRef.current;
          if (node === null) return;
          setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
        }}
      >
        <TaskNotices task={task} />
        <div className="timeline-head">
          <h2>Execução</h2>
          <span>{activity.length} {activity.length === 1 ? "evento" : "eventos"}</span>
        </div>
        {task.state === "RUNNING" && (
          <div className="running-row" role="status">
            <span className="pulse" aria-hidden="true" />
            <span>{task.stateReason.trim() !== "" ? task.stateReason : "Em execução — acompanhando eventos do runtime."}</span>
          </div>
        )}
        {activity.length === 0 && task.state !== "RUNNING" && (
          <div className="activity-empty">
            <strong>Nenhuma atividade registrada</strong>
            <span>Eventos do runtime aparecem aqui.</span>
          </div>
        )}
        {activity.map((item) => {
          switch (item.kind) {
            case "message":
              return <MessageRow key={`message-${item.value.id}`} message={item.value} />;
            case "tool":
              return (
                <ToolRow
                  key={`tool-${item.value.id}`}
                  tool={item.value}
                  open={state.detailId === item.value.id}
                  onOpen={() => { dispatch({ type: "select-detail", detailId: state.detailId === item.value.id ? null : item.value.id }); }}
                />
              );
            case "verification":
              return <VerificationRow key={`verification-${item.value.id}`} verification={item.value} />;
            case "steering":
              return <SteeringRow key={`steering-${item.value.id}`} steering={item.value} />;
          }
        })}
        <div ref={bottomRef} />
      </div>
      {!following && (
        <button
          type="button"
          className="btn jump-latest"
          onClick={() => {
            setFollowing(true);
            bottomRef.current?.scrollIntoView({ block: "nearest" });
          }}
        >
          Ir para a mais recente
        </button>
      )}
    </div>
  );
}

export function Detail({ api, state, dispatch }: DetailProps): JSX.Element | null {
  const task = state.task;
  const [full, setFull] = useState<string | null>(null);
  const [fullTruncated, setFullTruncated] = useState(false);
  const [detailState, setDetailState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [loadedDetailId, setLoadedDetailId] = useState<string | null>(null);
  useEffect(() => {
    setFull(null);
    setFullTruncated(false);
    setDetailState("loading");
    setLoadedDetailId(null);
    if (task === null || state.detailId === null) return;
    let cancelled = false;
    api
      .toolDetail(task.taskId, state.detailId)
      .then((result) => {
        if (!cancelled) {
          setFull(result.detail);
          setFullTruncated(result.truncated);
          setDetailState("ready");
          setLoadedDetailId(state.detailId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFull(null);
          setDetailState("unavailable");
          setLoadedDetailId(state.detailId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, task?.taskId, state.detailId]);
  if (task === null || state.detailId === null) return null;
  const tool = task.tools.find((entry) => entry.id === state.detailId);
  if (tool === undefined) return null;
  const selectedDetailState = loadedDetailId === state.detailId ? detailState : "loading";
  const summary = toolSummaryPreview(tool);
  return (
    <aside className="detail" id="tool-detail" aria-label="Detalhe da tool">
      <div className="detail-head">
        <div>
          <span className="detail-eyebrow">Inspetor de execução</span>
          <strong className="detail-title">{tool.tool}</strong>
        </div>
        <button type="button" className="btn icon" aria-label="Fechar detalhe" onClick={() => { dispatch({ type: "select-detail", detailId: null }); }}>
          {"×"}
        </button>
      </div>
      <div className="detail-body">
        <section className="inspector-section">
          <h3>Resultado</h3>
          <p className="detail-summary">{summary.text}</p>
          {summary.shortened && (
            <p className="summary-note">
              {selectedDetailState === "loading"
                ? "Resumo encurtado enquanto a evidência retida carrega."
                : selectedDetailState === "ready"
                  ? "Resumo encurtado. A evidência retida aparece abaixo."
                  : "Resumo encurtado; a evidência retida está indisponível."}
            </p>
          )}
        </section>
        <section className="inspector-section">
          <h3>Propriedades</h3>
          <dl className="inspector-kv">
            <dt>Estado</dt>
            <dd><span className={`statusmark statusmark-${tool.status}`} aria-hidden="true" />{toolStatusLabel(tool.status)}</dd>
            <dt>Alvo</dt>
            <dd title={tool.target ?? undefined}>{tool.target ?? "não registrado"}</dd>
            <dt>Duração</dt>
            <dd>{tool.durationMs === null ? "não registrada" : formatDuration(tool.durationMs)}</dd>
            <dt>Registrado</dt>
            <dd><time dateTime={tool.recordedAt}>{tool.recordedAt}</time></dd>
            <dt>Completa</dt>
            <dd>{tool.complete === null ? "desconhecido" : tool.complete ? "sim" : "não"}</dd>
            {tool.version !== null && <><dt>Versão</dt><dd>{tool.version}</dd></>}
          </dl>
        </section>
        {tool.tool === "edit" && selectedDetailState === "ready" && full !== null && <DiffView full={full} />}
        <section className="inspector-section output-section">
          <h3>Evidência</h3>
          {selectedDetailState === "loading" ? (
            <div className="detail-loading" role="status">
              <span>Carregando saída retida</span>
              <span className="opening-line" />
              <span className="opening-line short" />
            </div>
          ) : selectedDetailState === "unavailable" || full === null ? (
            <p className="meta">Saída retida indisponível. O resumo do resultado continua sendo a evidência.</p>
          ) : (
            <details className="raw-detail" open={tool.tool !== "edit"}>
              <summary>Saída retida</summary>
              <pre className="output">{full}</pre>
            </details>
          )}
          {fullTruncated && <p className="meta">Saída truncada no limite de retenção do servidor.</p>}
        </section>
      </div>
    </aside>
  );
}

export function Composer({ api, state, dispatch }: ComposerProps): JSX.Element {
  const task = state.task;
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");

  async function send(): Promise<void> {
    const text = state.draft.trim();
    if (task === null || text === "" || sending || composing) return;
    setSending(true);
    const commandId = createCommandId();
    dispatch({ type: "command-sent", command: { commandId, kind: "steer", text, sentAt: Date.now() } });
    dispatch({ type: "draft", draft: "" });
    try {
      const result = await api.command({
        commandId,
        kind: "steer",
        taskId: task.taskId,
        expectedRevision: task.contractRevision,
        payload: { text, mode: "guide" },
      });
      if (!result.accepted) {
        dispatch({ type: "draft", draft: text });
      }
    } catch {
      dispatch({ type: "draft", draft: text });
    } finally {
      setSending(false);
    }
  }

  async function stop(): Promise<void> {
    if (task === null || task.state !== "RUNNING" || sending) return;
    setSending(true);
    try {
      const commandId = createCommandId();
      dispatch({ type: "command-sent", command: { commandId, kind: "stop", text: "stop requested", sentAt: Date.now() } });
      await api.command({ commandId, kind: "stop", taskId: task.taskId });
    } finally {
      setSending(false);
    }
  }

  async function resume(): Promise<void> {
    if (task === null || task.state === "RUNNING" || sending) return;
    setSending(true);
    try {
      const resumed = await api.command({ commandId: createCommandId(), kind: "resume-task", taskId: task.taskId });
      if (!resumed.accepted) {
        setNotice("Retomada recusada pelo core; o estado ou a autoridade da tarefa não permite.");
        return;
      }
      const started = await api.command({ commandId: createCommandId(), kind: "start-task", taskId: task.taskId });
      setNotice(started.accepted ? "Retomada na mesma sessão e concessão" : "Retomada, mas a execução não foi aceita");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "falha ao retomar");
    } finally {
      setSending(false);
    }
  }

  if (task === null) return <div className="composer" />;
  const destination =
    task.state === "RUNNING"
      ? "orientação para o turno atual"
      : task.state === "NEEDS_INPUT"
        ? "resposta para a pergunta pendente"
        : "orientação registrada na tarefa";
  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-meta">
          <span className="composer-dest">{destination}</span>
          <span className="hint">{sendHint()}</span>
        </div>
        <textarea
          value={state.draft}
          aria-label="Mensagem para a tarefa"
          rows={2}
          placeholder="Orientar a tarefa"
          onChange={(event) => { dispatch({ type: "draft", draft: event.target.value }); }}
          onCompositionStart={() => { setComposing(true); }}
          onCompositionEnd={() => { setComposing(false); }}
          onKeyDown={(event) => {
            if (composerKeyAction(event, composing) === "send") {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          <span className="composer-state">rev {task.contractRevision} · {stateLabel(task.state)}</span>
          {task.state === "RUNNING" && (
            <button type="button" className="btn danger" disabled={sending} onClick={() => { void stop(); }}>
              Interromper
            </button>
          )}
          {task.state !== "RUNNING" && task.resumable && (
            <button type="button" className="btn" disabled={sending} onClick={() => { void resume(); }}>
              Retomar
            </button>
          )}
          <button type="button" className="btn primary" disabled={sending || state.draft.trim() === ""} onClick={() => { void send(); }}>
            {sending ? "Enviando" : "Enviar"}
          </button>
        </div>
        {notice !== "" && <p className="meta" role="status">{notice}</p>}
        {state.pending
          .filter((command) => command.kind === "steer" || command.kind === "stop")
          .map((command) => (
            <p key={command.commandId} className="meta" role="status">
              {command.kind === "stop" ? "interrupção pedida; aguardando o core confirmar" : `enviado: ${command.text}`}
            </p>
          ))}
      </div>
    </div>
  );
}

export interface ModelPick {
  providerId: string;
  model: string;
  baseUrl: string | null;
}

function discoveryErrorText(kind: string, detail: string): string {
  switch (kind) {
    case "auth":
      return "Credencial recusada pelo endpoint (401/403). Confira a chave.";
    case "timeout":
      return "Tempo esgotado ao contatar o endpoint.";
    case "network":
      return `Endpoint inacessível: ${detail}`;
    case "incompatible":
      return "Endpoint sem listagem de modelos. Use o ID manual.";
    default:
      return detail;
  }
}

function connectionText(result: ConnectionOutcome): string {
  if (result.ok) {
    return result.modelCount === 0
      ? "Acessível; o endpoint não lista modelos."
      : `Acessível; ${result.modelCount} modelo(s) listado(s).`;
  }
  return discoveryErrorText(result.kind, result.detail);
}

interface ModelPickerProps {
  api: ApiClient;
  providerId: string;
  model: string;
  baseUrl: string;
  hideProviderSelect?: boolean;
  endpointOverride?: string;
  onPick: (pick: ModelPick) => void;
}

function ModelPicker({ api, providerId, model, baseUrl, hideProviderSelect = false, endpointOverride, onPick }: ModelPickerProps): JSX.Element {
  const [presets, setPresets] = useState<ProviderPresetView[]>([]);
  const [keyMap, setKeyMap] = useState<Record<string, boolean>>({});
  const [currentProvider, setCurrentProvider] = useState(providerId);
  const [manual, setManual] = useState(model);
  const [endpointDraft, setEndpoint] = useState(baseUrl);
  const endpoint = endpointOverride ?? endpointDraft;
  const discoveryRequest = useRef(0);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState("");
  const [discovery, setDiscovery] = useState<{ state: "idle" | "loading" | "ready" | "error"; models: DiscoveredModelView[]; kind: string; detail: string }>(
    { state: "idle", models: [], kind: "", detail: "" },
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.providers(), api.providerStatus()])
      .then(([list, status]) => {
        if (cancelled) return;
        setPresets(list);
        const map: Record<string, boolean> = {};
        for (const entry of status) map[entry.id] = entry.keyConfigured;
        setKeyMap(map);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Não foi possível carregar os providers do servidor.");
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const preset = presets.find((entry) => entry.id === currentProvider) ?? null;

  useEffect(() => {
    discoveryRequest.current += 1;
    setDiscovery({ state: "idle", models: [], kind: "", detail: "" });
    return () => { discoveryRequest.current += 1; };
  }, [endpoint, currentProvider]);

  async function discover(): Promise<void> {
    const request = ++discoveryRequest.current;
    setDiscovery({ state: "loading", models: [], kind: "", detail: "" });
    try {
      const result: ModelsOutcome = await api.providerModels(currentProvider, endpoint.trim() !== "" ? endpoint.trim() : null);
      if (request !== discoveryRequest.current) return;
      if (result.ok) {
        setDiscovery({ state: "ready", models: result.models, kind: "", detail: "" });
      } else {
        setDiscovery({ state: "error", models: [], kind: result.kind, detail: result.detail });
      }
    } catch (error) {
      if (request !== discoveryRequest.current) return;
      setDiscovery({ state: "error", models: [], kind: "network", detail: error instanceof Error ? error.message : "falha de rede" });
    }
  }

  function pick(modelId: string): void {
    if (modelId.trim() === "") return;
    onPick({ providerId: currentProvider, model: modelId.trim(), baseUrl: endpoint.trim() !== "" ? endpoint.trim() : null });
  }

  const query = search.trim().toLowerCase();
  const visible = query === ""
    ? discovery.models
    : discovery.models.filter((entry) =>
      entry.id.toLowerCase().includes(query) || (entry.displayName ?? "").toLowerCase().includes(query),
    );

  return (
    <div className="modelpicker">
      {!hideProviderSelect && (
        <label>
          Provedor
          <select
            autoFocus
            value={currentProvider}
            aria-label="Provedor"
            onChange={(event) => {
              setCurrentProvider(event.target.value);
              setDiscovery({ state: "idle", models: [], kind: "", detail: "" });
            }}
          >
            {presets.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.displayName}</option>
            ))}
            <option value="custom">Custom OpenAI-compatible</option>
          </select>
        </label>
      )}
      {!hideProviderSelect && preset !== null && <p className="meta">{preset.note}</p>}
      {!hideProviderSelect && currentProvider === "custom" && preset === null && (
        <p className="meta">Endpoint arbitrário OpenAI-compatible. Listagem e tools dependem do servidor.</p>
      )}
      {endpointOverride === undefined && <label>
        Endpoint (opcional)
        <input
          value={endpoint}
          aria-label="Endpoint"
          placeholder={preset?.defaultBaseUrl ?? "https://.../v1"}
          onChange={(event) => { setEndpoint(event.target.value); }}
        />
      </label>}
      {!hideProviderSelect && preset?.keyRequired === true && keyMap[currentProvider] !== true && (
        <p className="meta">Sem credencial configurada; a listagem pode recusar (401). Configure em Providers.</p>
      )}
      <div className="modelpicker-actions">
        <button type="button" className="btn" disabled={discovery.state === "loading"} onClick={() => { void discover(); }}>
          {discovery.state === "loading" ? "Consultando…" : discovery.state === "ready" ? "Atualizar modelos" : "Listar modelos"}
        </button>
      </div>
      {discovery.state === "error" && (
        <p className="meta error" role="alert">Listagem indisponível ({discovery.kind}): {discovery.detail !== "" ? discoveryErrorText(discovery.kind, discovery.detail) : ""}</p>
      )}
      {discovery.state === "ready" && (
        discovery.models.length === 0 ? (
          <p className="meta" role="status">Endpoint acessível, mas não lista modelos. Use o ID manual abaixo.</p>
        ) : (
          <>
            <label>
              Buscar modelos
              <input value={search} aria-label="Buscar modelos" onChange={(event) => { setSearch(event.target.value); }} placeholder="filtrar por id ou nome" />
            </label>
            <ul className="modellist" aria-label="Modelos descobertos">
              {visible.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className={entry.id === manual.trim() ? "modelrow selected" : "modelrow"} onClick={() => { pick(entry.id); }} title={entry.id}>
                    <span className="modelrow-id">{entry.displayName ?? entry.id}</span>
                    {entry.displayName !== null && <span className="modelrow-meta">{entry.id}</span>}
                  </button>
                </li>
              ))}
              {visible.length === 0 && <li className="empty">Nenhum modelo corresponde à busca.</li>}
            </ul>
          </>
        )
      )}
      <label>
        ID manual do modelo
        <input value={manual} aria-label="Modelo" onChange={(event) => { setManual(event.target.value); }} placeholder="Identificador do modelo" />
      </label>
      <div className="modelpicker-actions">
        <button type="button" className="btn primary" disabled={manual.trim() === ""} onClick={() => { pick(manual); }}>
          Usar este modelo
        </button>
      </div>
      {loadError !== "" && <p className="meta error" role="alert">{loadError}</p>}
    </div>
  );
}

function WorkspacePicker({ api, onPick }: { api: ApiClient; onPick: (path: string, displayName: string) => void }): JSX.Element {
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function browse(next: string): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setEntries(await api.browseWorkspace(next));
      setRel(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "não foi possível listar a pasta");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void browse("");
  }, [api]);

  async function choose(candidate: string): Promise<void> {
    setError("");
    try {
      const resolved = await api.resolveWorkspace(candidate);
      onPick(resolved.path, resolved.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "pasta inválida");
    }
  }

  const up = rel === "" ? null : rel.split("/").slice(0, -1).join("/");

  return (
    <div className="workspacepicker">
      <p className="meta">Pasta atual: {rel === "" ? "(raiz do servidor)" : rel}</p>
      <div className="modelpicker-actions">
        {up !== null && (
          <button type="button" className="btn" onClick={() => { void browse(up); }}>Subir um nível</button>
        )}
        <button type="button" className="btn primary" onClick={() => { void choose(rel === "" ? "." : rel); }}>
          Escolher esta pasta
        </button>
      </div>
      {loading && <p className="meta" role="status">Listando pastas…</p>}
      <ul className="modellist" aria-label="Subpastas">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="modelrow" onClick={() => { void browse(rel === "" ? entry.name : `${rel}/${entry.name}`); }} title={entry.path}>
              <span className="modelrow-id">{entry.name}</span>
            </button>
          </li>
        ))}
        {entries.length === 0 && !loading && <li className="empty">Sem subpastas aqui.</li>}
      </ul>
      <label>
        Caminho manual
        <input autoFocus value={manual} aria-label="Caminho da pasta" onChange={(event) => { setManual(event.target.value); }} placeholder="/caminho/absoluto ou relativo à raiz" />
      </label>
      <div className="modelpicker-actions">
        <button type="button" className="btn" disabled={manual.trim() === ""} onClick={() => { void choose(manual); }}>
          Validar e usar
        </button>
      </div>
      {error !== "" && <p className="meta error" role="alert">{error}</p>}
    </div>
  );
}

export function NewTask({ api, state, dispatch }: NewTaskProps): JSX.Element {
  const [objective, setObjective] = useState("");
  const [providerId, setProviderId] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [panel, setPanel] = useState<"model" | "workspace" | null>(null);
  const [composing, setComposing] = useState(false);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .info()
      .then((info) => {
        if (!cancelled) setWorkspace(info.workspace);
      })
      .catch(() => undefined);
    void loadUiDefaults(api).then((defaults) => {
      if (cancelled) return;
      setProviderId(defaults.providerId);
      if (defaults.model !== "") setModel(defaults.model);
      if (defaults.baseUrl !== null) setBaseUrl(defaults.baseUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function persistDefaults(pick: ModelPick): Promise<void> {
    setProviderId(pick.providerId);
    setModel(pick.model);
    setBaseUrl(pick.baseUrl ?? "");
    if (pick.model.trim() !== "") {
      setError("");
      await saveUiDefaults(api, { providerId: pick.providerId, model: pick.model, baseUrl: pick.baseUrl });
    }
  }

  async function start(): Promise<void> {
    if (objective.trim() === "" || starting) return;
    if (model.trim() === "") {
      setError("Escolha o modelo antes de iniciar a tarefa.");
      setPanel("model");
      return;
    }
    setStarting(true);
    setError("");
    try {
      const created = await api.command({
        commandId: createCommandId(),
        kind: "create-task",
        payload: { workspace, objective: objective.trim(), provider: providerId, model: model.trim(), baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim() },
      });
      if (!created.accepted || created.taskId === "") {
        setError("A tarefa não foi aceita pelo runtime.");
        return;
      }
      const started = await api.command({ commandId: createCommandId(), kind: "start-task", taskId: created.taskId });
      if (!started.accepted) {
        setError("A tarefa foi criada, mas a execução não foi aceita.");
        return;
      }
      await saveUiDefaults(api, { providerId, model: model.trim(), baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim() });
      dispatch({ type: "open-task", taskId: created.taskId });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Não foi possível iniciar a tarefa.");
    } finally {
      setStarting(false);
    }
  }

  const workspaceLabel = workspace === ""
    ? "Abrindo pasta de trabalho"
    : workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
  const recent = state.sessions.slice(0, 5);

  return (
    <section className="newtask" aria-labelledby="newtask-title">
      <div className="newtask-emblem" aria-hidden="true"><span className="brandmark" /></div>
      <p className="newtask-eyebrow">Lattice Agent · Harness local</p>
      <h1 id="newtask-title">O que vamos construir?</h1>
      <p className="newtask-subtitle">Uma tarefa, seu contexto. Do código à verificação.</p>
      <div className="newtask-controls" aria-label="Contexto da nova tarefa">
        <div className="newtask-modelwrap">
          <button
            type="button"
            ref={workspaceButtonRef}
            className="workspace-context workspace-contextbtn"
            title={workspace}
            aria-expanded={panel === "workspace"}
            aria-controls="new-task-workspace-picker"
            aria-haspopup="dialog"
            onClick={() => { setPanel((current) => (current === "workspace" ? null : "workspace")); }}
          >
            <UiIcon name="folder" /><span className="context-key">Pasta</span>
            <span className="context-value">{workspaceLabel}</span>
            <span className="disclosure" aria-hidden="true">{panel === "workspace" ? "˄" : "˅"}</span>
          </button>
          {panel === "workspace" && (
            <div
              className="newtask-modelconfig"
              id="new-task-workspace-picker"
              role="dialog"
              aria-label="Escolha da pasta"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setPanel(null);
                  workspaceButtonRef.current?.focus();
                }
              }}
            >
              <div className="newtask-modelconfig-head">
                <div>
                  <strong>Escolha da pasta</strong>
                  <span>Validada pelo servidor, contida na raiz servida.</span>
                </div>
                <button type="button" className="btn icon" aria-label="Fechar escolha da pasta" onClick={() => { setPanel(null); }}>×</button>
              </div>
              <WorkspacePicker
                api={api}
                onPick={(picked) => {
                  setWorkspace(picked);
                  setPanel(null);
                  workspaceButtonRef.current?.focus();
                }}
              />
            </div>
          )}
        </div>
        <div className="newtask-modelwrap">
          <button
            type="button"
            ref={modelButtonRef}
            className={model.trim() === "" ? "newtask-modelbtn needs-value" : "newtask-modelbtn"}
            aria-expanded={panel === "model"}
            aria-controls="new-task-model-config"
            aria-haspopup="dialog"
            onClick={() => { setPanel((current) => (current === "model" ? null : "model")); }}
          >
            <span className="context-key">Modelo</span>
            <span className="context-value">{model.trim() === "" ? "Configurar" : model.trim()}</span>
            <span className="disclosure" aria-hidden="true">{panel === "model" ? "˄" : "˅"}</span>
          </button>
          {panel === "model" && (
            <div
              className="newtask-modelconfig newtask-modelconfig-wide"
              id="new-task-model-config"
              role="dialog"
              aria-label="Configuração do modelo"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setPanel(null);
                  modelButtonRef.current?.focus();
                }
              }}
            >
              <div className="newtask-modelconfig-head">
                <div>
                  <strong>Configuração do modelo</strong>
                  <span>Descoberta real quando o provider lista; ID manual sempre disponível.</span>
                </div>
                <button type="button" className="btn icon" aria-label="Fechar configuração do modelo" onClick={() => { setPanel(null); }}>×</button>
              </div>
              <ModelPicker
                api={api}
                providerId={providerId}
                model={model}
                baseUrl={baseUrl}
                onPick={(pick) => {
                  void persistDefaults(pick);
                  setPanel(null);
                  modelButtonRef.current?.focus();
                }}
              />
              <div className="newtask-modelconfig-action">
                <button type="button" className="btn" onClick={() => { setPanel(null); }}>Concluir</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <form
        className="newtask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <textarea
          id="new-task-objective"
          autoFocus
          value={objective}
          rows={3}
          aria-label="Descreva a tarefa"
          placeholder="O que você quer fazer nesta pasta?"
          onChange={(event) => { setObjective(event.target.value); }}
          onCompositionStart={() => { setComposing(true); }}
          onCompositionEnd={() => { setComposing(false); }}
          onKeyDown={(event) => {
            if (composerKeyAction(event, composing) === "send") {
              event.preventDefault();
              void start();
            }
          }}
        />
        <div className="newtask-composer-actions">
          <span><UiIcon name="terminal" />Execução local</span>
          <button
            type="submit"
            className="newtask-submit"
            disabled={starting || objective.trim() === ""}
            aria-label={starting ? "Iniciando tarefa" : "Iniciar tarefa"}
            title={starting ? "Iniciando tarefa" : "Iniciar tarefa"}
          >
            {starting ? "···" : "↑"}
          </button>
        </div>
      </form>
      <div className="newtask-footnote">
        <span>{sendOnEnterEnabled() ? "Enter para iniciar · Shift+Enter para nova linha" : "Ctrl+Enter para iniciar · Enter para nova linha"}</span>
        {error !== "" && <span className="error" role="alert">{error}</span>}
      </div>
      {recent.length > 0 && (
        <div className="newtask-recent">
          <div className="newtask-recent-head">
            <span>Sessões recentes</span>
          </div>
          <ul>
            {recent.map((session) => (
              <li key={session.taskId}>
                <button
                  type="button"
                  className="recent-session"
                  onClick={() => { dispatch({ type: "open-task", taskId: session.taskId }); }}
                >
                  <span className={`session-state session-state-${session.state.toLowerCase().replace("_", "-")}`} aria-hidden="true" />
                  <span className="session-objective">{session.objective === "" ? "(tarefa sem título)" : session.objective}</span>
                  <span className="session-meta">{stateLabel(session.state)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface ProviderCardView {
  id: string;
  displayName: string;
  note: string;
  docsUrl: string;
  keyRequired: boolean;
  keyLabel: string;
  defaultBaseUrl: string;
  custom: boolean;
}

function ProviderDetail({ api, card, keyOn, isDefault, defaults, onChanged }: {
  api: ApiClient;
  card: ProviderCardView;
  keyOn: boolean;
  isDefault: boolean;
  defaults: UiModelDefaults;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [key, setKey] = useState("");
  const [endpoint, setEndpoint] = useState(isDefault ? defaults.baseUrl ?? card.defaultBaseUrl : card.defaultBaseUrl);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [test, setTest] = useState<ConnectionOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const testRequest = useRef(0);

  useEffect(() => () => { testRequest.current += 1; }, []);

  async function changeKey(remove: boolean): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    testRequest.current += 1;
    setTest(null);
    setTesting(false);
    try {
      if (remove) {
        await api.removeProviderKey(card.id);
      } else {
        const result = await api.command({ commandId: createCommandId(), kind: "set-key", payload: { provider: card.id, key } });
        if (!result.accepted) throw new Error("O servidor não aceitou a credencial.");
      }
      setKey("");
      setShowModels(false);
      await onChanged();
      setNotice(remove ? "Credencial removida desta sessão." : "Credencial salva em memória nesta sessão do servidor.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível atualizar a credencial.");
    } finally {
      setBusy(false);
    }
  }

  async function runTest(): Promise<void> {
    const request = ++testRequest.current;
    setTesting(true);
    setTest(null);
    try {
      const result = await api.testProvider(card.id, endpoint.trim() || null);
      if (request === testRequest.current) setTest(result);
    } catch (err) {
      if (request === testRequest.current) setTest({ ok: false, providerId: card.id, baseUrl: endpoint, kind: "network", modelCount: 0, detail: err instanceof Error ? err.message : "Falha de rede" });
    } finally {
      if (request === testRequest.current) setTesting(false);
    }
  }

  async function useModel(pick: ModelPick): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const current = await api.productConfig();
      if (current === null) throw new Error("Este servidor não permite salvar o provider padrão. Configure o modelo na tarefa.");
      await api.saveProductConfig({ ...current, defaultProviderId: pick.providerId, defaultModel: pick.model, defaultBaseUrl: pick.baseUrl });
      await onChanged();
      setNotice(`Padrão das novas tarefas: ${pick.model}. A tarefa ativa mantém seu modelo.`);
      setShowModels(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar o modelo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="provider-detail" aria-label={`Configuração de ${card.displayName}`}>
      <header className="provider-detail-head">
        <div><h3>{card.displayName}</h3><p>{card.note}</p></div>
        {card.docsUrl !== "" && <a href={card.docsUrl} target="_blank" rel="noreferrer">Documentação ↗</a>}
      </header>
      <details className="provider-field provider-credential" open={card.keyRequired || keyOn}>
        <summary className="keyrow">
          <h4>Credencial {card.keyRequired ? "" : <span>opcional</span>}</h4>
          <span className={keyOn ? "credential-state configured" : "credential-state"}>{keyOn ? "Configurada · sessão" : "Não configurada"}</span>
        </summary>
        <label>
          <span className="sr-only">{card.keyLabel}</span>
          <input type="password" value={key} onChange={(event) => { setKey(event.target.value); }} autoComplete="off" aria-label={`Chave de API ${card.displayName}`} placeholder={keyOn ? "Nova chave para substituir a atual" : card.keyRequired ? "Cole sua chave de API" : "Informe somente se o servidor exigir"} />
        </label>
        <div className="provider-inline-actions">
          <span className="meta">{card.custom ? "Credencial compartilhada pelos endpoints Custom nesta sessão." : "A chave fica apenas na memória do servidor."}</span>
          <button type="button" className="btn" disabled={busy || key.trim() === ""} onClick={() => { void changeKey(false); }}>{keyOn ? "Substituir chave" : "Salvar chave"}</button>
          {keyOn && <button type="button" className="btn" disabled={busy} onClick={() => { void changeKey(true); }}>Remover chave</button>}
        </div>
      </details>
      <div className="provider-field">
        <label>Endpoint
          <input value={endpoint} aria-label="Endpoint do provider" placeholder={card.defaultBaseUrl} onChange={(event) => {
            setEndpoint(event.target.value);
            testRequest.current += 1;
            setTest(null);
            setTesting(false);
          }} />
        </label>
        <div className="provider-inline-actions">
          <span className="meta">{card.id === "local" ? "Servidor local já em execução. Pesos e modelos são gerenciados fora do Lattice." : card.custom ? "Serviço OpenAI-compatible. Compatibilidade depende do endpoint." : "Usado no teste e na descoberta de modelos."}</span>
          <button type="button" className="btn" disabled={testing || busy || endpoint.trim() === ""} onClick={() => { void runTest(); }}>{testing ? "Testando…" : "Testar conexão"}</button>
        </div>
        {test !== null && <p className={test.ok ? "provider-feedback success" : "provider-feedback error"} role="status">{connectionText(test)}</p>}
      </div>
      <div className="provider-field">
        <div className="provider-model-head">
          <div><h4>Modelo para novas tarefas</h4><p className="meta">{isDefault && defaults.model !== "" ? defaults.model : "Nenhum modelo padrão neste provider"}</p></div>
          <button type="button" className="btn" disabled={busy} aria-expanded={showModels} onClick={() => { setShowModels((open) => !open); }}>{showModels ? "Fechar modelos" : "Escolher modelo"}</button>
        </div>
        {showModels && <ModelPicker api={api} providerId={card.id} model={isDefault ? defaults.model : ""} baseUrl={endpoint} endpointOverride={endpoint} hideProviderSelect onPick={(pick) => { if (!busy) void useModel(pick); }} />}
        <p className="provider-save-hint">Escolher um modelo salva o provider e o endpoint como padrão. Testar conexão não salva alterações.</p>
      </div>
      {notice !== "" && <p className="provider-feedback" role="status">{notice}</p>}
      {error !== "" && <p className="provider-feedback error" role="alert">{error}</p>}
    </section>
  );
}

function ProvidersSection({ api, onDefaults }: { api: ApiClient; onDefaults: () => void }): JSX.Element {
  const [presets, setPresets] = useState<ProviderPresetView[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, boolean>>({});
  const [defaults, setDefaults] = useState<UiModelDefaults>({ providerId: "openai", model: "", baseUrl: null });
  const [configSource, setConfigSource] = useState<"server" | "browser">("browser");
  const [customs, setCustoms] = useState<ProductConfigView["customProviders"]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCustom, setSavingCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBase, setCustomBase] = useState("");
  const [customKey, setCustomKey] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async (): Promise<void> => {
    setError("");
    try {
      const [list, status, config] = await Promise.all([
        api.providers(),
        api.providerStatus(),
        api.productConfig().catch(() => null),
      ]);
      setPresets(list);
      const map: Record<string, boolean> = {};
      for (const entry of status) map[entry.id] = entry.keyConfigured;
      setStatusMap(map);
      if (config !== null) {
        setDefaults({ providerId: config.defaultProviderId, model: config.defaultModel, baseUrl: config.defaultBaseUrl });
        setCustoms(config.customProviders);
        setConfigSource("server");
      } else {
        const legacy = loadModelDefaults();
        setDefaults({ providerId: "openai", model: legacy.model, baseUrl: legacy.baseUrl });
        setCustoms([]);
        setConfigSource("browser");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "não foi possível carregar os providers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [api]);

  async function saveCustom(): Promise<void> {
    setError("");
    setNotice("");
    if (customName.trim() === "" || customBase.trim() === "") {
      setError("Custom precisa de nome e endpoint.");
      return;
    }
    try {
      const current = await api.productConfig();
      if (current === null) {
        setError("Este servidor não persiste configuração; custom ficaria só nesta tela.");
        return;
      }
      setSavingCustom(true);
      const next = await api.saveProductConfig({
        ...current,
        customProviders: [...current.customProviders, { displayName: customName.trim(), baseUrl: customBase.trim(), keyRequired: customKey }],
      });
      setCustoms(next.customProviders);
      const saved = next.customProviders.at(-1);
      if (saved !== undefined) setSelectedProvider(`custom:${saved.displayName}:${saved.baseUrl}`);
      setCustomName("");
      setCustomBase("");
      setCustomKey(false);
      setNotice("Provider custom salvo neste servidor.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "não foi possível salvar o custom");
    } finally {
      setSavingCustom(false);
    }
  }

  const cards: ProviderCardView[] = [
    ...presets.map((preset) => ({
      id: preset.id,
      displayName: preset.displayName,
      note: preset.note,
      docsUrl: preset.docsUrl,
      keyRequired: preset.keyRequired,
      keyLabel: preset.keyLabel,
      defaultBaseUrl: preset.defaultBaseUrl,
      custom: false,
    })),
    ...customs.map((custom) => ({
      id: "custom" as const,
      displayName: custom.displayName,
      note: "Endpoint OpenAI-compatible personalizado. Listagem e tools dependem do servidor.",
      docsUrl: "",
      keyRequired: custom.keyRequired,
      keyLabel: "Chave de API",
      defaultBaseUrl: custom.baseUrl,
      custom: true,
    })),
  ];

  const cardKey = (card: ProviderCardView): string => card.custom ? `custom:${card.displayName}:${card.defaultBaseUrl}` : card.id;
  const isDefault = (card: ProviderCardView): boolean => defaults.providerId === card.id && (!card.custom || defaults.baseUrl === card.defaultBaseUrl);
  const selected = selectedProvider === "add-custom" ? null
    : cards.find((card) => cardKey(card) === selectedProvider) ?? cards.find(isDefault) ?? cards[0] ?? null;

  return (
    <div className="providers-section">
      <h2>Providers</h2>
      <p className="settings-lead">Configure os serviços usados pelo Lattice.</p>
      <p className="provider-default">Padrão atual: <strong>{defaults.providerId}{defaults.model !== "" ? ` / ${defaults.model}` : ""}</strong> · {configSource === "server" ? "neste servidor" : "neste navegador"}</p>
      {error !== "" && <p className="provider-feedback error" role="alert">{error} <button type="button" className="btn" onClick={() => { void refresh(); }}>Tentar novamente</button></p>}
      {loading && <p role="status" className="meta">Carregando providers…</p>}
      {!loading && cards.length === 0 && error === "" && <p className="meta">Nenhum provider retornado pelo servidor.</p>}
      <div className="providers-layout">
        <nav className="provider-master" aria-label="Providers" onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}>
          {cards.map((card) => (
            <button type="button" key={cardKey(card)} className={selected === card ? "provider-option selected" : "provider-option"} aria-current={selected === card} onClick={() => { setSelectedProvider(cardKey(card)); setNotice(""); }}>
              <span className="provider-option-name">{card.displayName}{isDefault(card) && <span className="provider-default-mark" title="Provider padrão" aria-label="Provider padrão">●</span>}</span>
              <span className="provider-option-state">{statusMap[card.id] === true ? "Configurado · sessão" : card.keyRequired ? "Não configurado" : "Chave opcional"}</span>
            </button>
          ))}
          <button type="button" className={selectedProvider === "add-custom" ? "provider-option selected" : "provider-option"} aria-current={selectedProvider === "add-custom"} onClick={() => { setSelectedProvider("add-custom"); setNotice(""); }}>
            <span className="provider-option-name">+ Custom</span><span className="provider-option-state">Adicionar endpoint</span>
          </button>
        </nav>
        <div className="provider-detail-slot">
          {selected !== null && <ProviderDetail key={cardKey(selected)} api={api} card={selected} keyOn={statusMap[selected.id] === true} isDefault={isDefault(selected)} defaults={defaults} onChanged={async () => { setNotice(""); await refresh(); onDefaults(); }} />}
          {selectedProvider === "add-custom" && <div className="provider-detail provider-custom-form">
        <header className="provider-detail-head"><div><h3>Custom OpenAI-compatible</h3><p>Adicione um serviço pelo nome e endpoint. Depois, configure o modelo e a credencial se necessária.</p></div></header>
        <label>
          Nome de exibição
          <input value={customName} aria-label="Nome do custom" onChange={(event) => { setCustomName(event.target.value); }} placeholder="ACME gateway" />
        </label>
        <label>
          Endpoint base
          <input value={customBase} aria-label="Endpoint do custom" onChange={(event) => { setCustomBase(event.target.value); }} placeholder="https://gateway.exemplo/v1" />
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={customKey} aria-label="Custom exige chave" onChange={(event) => { setCustomKey(event.target.checked); }} />
          <span>Exige chave de API</span>
        </label>
        <div className="settings-actions">
          <button type="button" className="btn primary" disabled={savingCustom} onClick={() => { void saveCustom(); }}>
            {savingCustom ? "Salvando…" : "Salvar custom"}
          </button>
        </div>
          </div>}
          {notice !== "" && <p className="provider-feedback" role="status">{notice}</p>}
        </div>
      </div>
    </div>
  );
}

export function SettingsView({ api, state, dispatch }: SettingsProps): JSX.Element {
  const [category, setCategory] = useState<"geral" | "providers">("providers");
  const [workspace, setWorkspace] = useState("");
  const [enterSends, setEnterSends] = useState(() => sendOnEnterEnabled());
  const task = state.task;

  useEffect(() => {
    let cancelled = false;
    api
      .info()
      .then((info) => {
        if (!cancelled) setWorkspace(info.workspace);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  function backToTask(): void {
    if (state.activeTaskId !== null) dispatch({ type: "open-task", taskId: state.activeTaskId });
    dispatch({ type: "set-view", view: "task" });
  }

  return (
    <section className="settings" aria-labelledby="settings-title">
      <div className="settings-head">
        <div>
          <p className="settings-eyebrow">Produto</p>
          <h1 id="settings-title">Configurações</h1>
        </div>
        <button type="button" className="btn" onClick={backToTask}>Voltar à tarefa</button>
      </div>
      <div className={category === "providers" ? "settings-body settings-providers" : "settings-body"}>
        <nav className="settings-nav" aria-label="Categorias de configuração">
          {(["geral", "providers"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              className={category === entry ? "settings-navitem active" : "settings-navitem"}
              aria-current={category === entry}
              onClick={() => { setCategory(entry); }}
            >
              {entry === "geral" ? "Geral" : "Providers"}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {category === "geral" && (
            <>
              <h2>Geral</h2>
              <p className="settings-lead">Pasta de trabalho, conexão e preferências da interface.</p>
              <div className="settings-card">
                <h3>Pasta de trabalho</h3>
                <p className="settings-path" title={workspace}>{workspace === "" ? "Abrindo pasta de trabalho" : workspace}</p>
                <p className="meta">Toda execução acontece nesta pasta, sob concessão explícita da tarefa.</p>
              </div>
              <div className="settings-card">
                <h3>Conexão com o runtime</h3>
                <p className="meta">{connectionLabel(state)} · loopback local com eventos em tempo real.</p>
              </div>
              <div className="settings-card">
                <h3>Envio com Enter</h3>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={enterSends}
                    aria-label="Enter envia a mensagem"
                    onChange={(event) => {
                      setEnterSends(event.target.checked);
                      setSendOnEnter(event.target.checked);
                    }}
                  />
                  <span>Enter envia a mensagem</span>
                </label>
                <p className="meta">Desligado: Enter quebra linha e Ctrl+Enter (ou Cmd+Enter) envia. Vale neste navegador, para todas as tarefas. Composição IME nunca envia.</p>
              </div>
              <div className="settings-card">
                <h3>Modo de execução e limites</h3>
                <p className="meta">Realm <code>local-trusted</code>: ferramentas de arquivo no workspace e comandos de projeto com seus privilégios.</p>
                <p className="meta">
                  {task !== null
                    ? `Tarefa ativa: ${task.budget.settledCalls + task.budget.reservedCalls}/${task.budget.grantedCalls} chamadas · ${formatTokens(task.budget.settledTokens + task.budget.reservedTokens)}/${formatTokens(task.budget.grantedTokens)} tokens (dados do core).`
                    : "Abra uma tarefa para ver a concessão usada."}
                </p>
                <p className="meta">Validade de 30 minutos, timeout de 5 minutos por comando e concessão padrão de 50 chamadas e 200 mil tokens são fixos do servidor nesta fase.</p>
              </div>
              <div className="settings-card">
                <h3>Retomada</h3>
                <p className="meta">Retomada é manual: tarefas pausadas, bloqueadas ou interrompidas oferecem Retomar na mesma sessão e concessão. Nada recomeça sozinho.</p>
              </div>
              <div className="settings-card">
                <h3>Segredos</h3>
                <p className="meta">A chave de API fica só em memória no servidor local e nunca é exibida de novo, nem entra em URL, transcript ou logs.</p>
              </div>
            </>
          )}
          {category === "providers" && (
            <ProvidersSection api={api} onDefaults={() => undefined} />
          )}
        </div>
      </div>
    </section>
  );
}

const HELP_STATES: Array<{ state: "READY" | "RUNNING" | "WAITING" | "NEEDS_INPUT" | "BLOCKED" | "COMPLETED" | "CANCELLED"; meaning: string }> = [
  { state: "READY", meaning: "Pronta; composer ativo para orientar." },
  { state: "RUNNING", meaning: "Ação atual em curso; dá para orientar e interromper." },
  { state: "WAITING", meaning: "Pausada numa condição; manter o app aberto." },
  { state: "NEEDS_INPUT", meaning: "Precisa de uma decisão sua para continuar." },
  { state: "BLOCKED", meaning: "Impedida; mostra evidência e caminho possível." },
  { state: "COMPLETED", meaning: "Resultado e verificações; pendências explicitadas." },
  { state: "CANCELLED", meaning: "Interrompida; o que já ocorreu continua visível." },
];

// Editorial reference to docs/future/INTERACTION_EXTENSIBILITY_SURFACE.md §§5–6.
// These entries are documentation only, never executable command descriptors.
const PLANNED_COMMAND_GROUPS = [
  { title: "Operação da tarefa", commands: [
    ["/status", "Consultar estado e execução sem chamar o modelo."],
    ["/model", "Abrir o seletor da tarefa; aplicar em ponto seguro."],
    ["/diff", "Inspecionar alterações e sua revisão."],
    ["/stop", "Solicitar interrupção e observar os efeitos."],
    ["/resume", "Solicitar retomada sob a concessão original."],
    ["/help", "Consultar o catálogo local de comandos."],
  ] },
  { title: "Planejamento e evidência", commands: [
    ["/plan", "Planejar com restrição de mutações."],
    ["/review", "Solicitar revisão; não implica commit ou push."],
    ["/debug", "Investigar um problema a partir da evidência."],
    ["/research", "Pesquisar dentro do escopo e orçamento autorizados."],
    ["/verify", "Solicitar verificação dos critérios da tarefa."],
    ["/test", "Executar testes com alvo e pasta definidos."],
  ] },
  { title: "Contexto e continuidade", commands: [
    ["/context", "Inspecionar referências, custos e conteúdo omitido."],
    ["/budget", "Consultar orçamento ou solicitar extensão explícita."],
    ["/provider", "Inspecionar ou configurar a rota; sem chaves no comando."],
    ["/checkpoint", "Registrar um ponto de continuidade derivado do histórico."],
    ["/wait", "Definir condição e limite de espera."],
    ["/reconcile", "Solicitar observação de um efeito incerto."],
    ["/retry", "Propor repetição apenas após avaliar a segurança."],
    ["/compact", "Propor compactação preservando referências essenciais."],
    ["/fork", "Propor uma nova tarefa; adoção adiada."],
  ] },
  { title: "Extensões e referências @", commands: [
    ["/skill use \"local/security-review\" --version \"1.2.0\"", "Selecionar um procedimento versionado, sem executá-lo automaticamente."],
    ["/profile", "Selecionar defaults e requisitos de um perfil."],
    ["/tools", "Consultar capacidades e motivos de indisponibilidade."],
    ["/mcp", "Gerenciar conexões sob autorização própria."],
    ["/plugin disable", "Solicitar desativação de uma extensão."],
    ["/browser inspect \"tab-7\"", "Inspecionar uma sessão de navegador."],
    ["/memory inspect \"claim-42\"", "Inspecionar uma memória identificada."],
    ["/agent", "Alias candidato para perfil; nome adiado, sem subagentes implícitos."],
    ["@skills/security-review.md", "Exemplo de referência tipada futura. Arquivos, pastas, evidências, sessões e perfis também são candidatos."],
  ] },
];

export function HelpView({ state, dispatch }: { state: UiState; dispatch: Dispatch }): JSX.Element {
  function backToTask(): void {
    if (state.activeTaskId !== null) dispatch({ type: "open-task", taskId: state.activeTaskId });
    dispatch({ type: "set-view", view: "task" });
  }

  return (
    <section className="settings" aria-labelledby="help-title">
      <div className="settings-head">
        <div>
          <p className="settings-eyebrow">Produto</p>
          <h1 id="help-title">Ajuda</h1>
        </div>
        <button type="button" className="btn" onClick={backToTask}>Voltar à tarefa</button>
      </div>
      <div className="settings-body">
        <div className="settings-content help-content">
          <section className="help-commands" aria-labelledby="commands-title">
            <h2 id="commands-title">Comandos</h2>
            <p className="settings-lead">O que você pode fazer hoje e a linguagem prevista para o Lattice.</p>
            <div className="help-section-heading"><h3>Disponível</h3><span className="availability available">Na interface</span></div>
            <dl className="available-actions">
              <div><dt>Tarefa e sessão</dt><dd>Nova tarefa, busca e histórico na barra lateral.</dd></div>
              <div><dt>Modelo e provider</dt><dd>Seletor no cabeçalho da tarefa. Mudanças aguardam confirmação em ponto seguro.</dd></div>
              <div><dt>Orientar · interromper · retomar</dt><dd>Composer e botões da tarefa, conforme o estado permite. Recebido não significa aplicado.</dd></div>
              <div><dt>Diff, testes e evidência</dt><dd>Abra uma linha de ferramenta no inspetor. Testes mostram os resultados e contagens conhecidos.</dd></div>
            </dl>
            <div className="help-section-heading"><h3>Planejado</h3><span className="availability planned">Ainda não executável</span></div>
            <p className="commands-caveat">Slash e referências @ ainda não são interpretados. Hoje, digitá-los no composer envia texto comum ao agente.</p>
            <div className="planned-commands">
              {PLANNED_COMMAND_GROUPS.map((group, index) => (
                <details className="command-group" key={group.title} open={index === 0}>
                  <summary>{group.title}<span>{group.commands.length} entradas · planejadas</span></summary>
                  <dl className="command-entries">
                    {group.commands.map(([syntax, description]) => <div key={syntax}><dt><code>{syntax}</code></dt><dd>{description}</dd></div>)}
                  </dl>
                </details>
              ))}
            </div>
            <p className="help-source">Referência: estudo de extensibilidade, §§5–6. /help, /status, /stop, /model, /diff e /test são formas curtas candidatas. Parser, catálogo compartilhado e paleta continuam planejados.</p>
          </section>
          <details className="help-guide">
          <summary>Atalhos, estados e uso da interface</summary>
          <h2>Atalhos de teclado</h2>
          <dl className="help-keys">
            <dt>Enter</dt><dd>Envia a mensagem do composer, salvo preferência em contrário (Configurações › Geral).</dd>
            <dt>Shift+Enter</dt><dd>Quebra linha sem enviar.</dd>
            <dt>Ctrl / Cmd+Enter</dt><dd>Envia independentemente da preferência de Enter; composição IME não envia.</dd>
            <dt>Escape</dt><dd>Fecha seletores de modelo e pasta. Não equivale a interromper a tarefa.</dd>
            <dt>Tab</dt><dd>Navega entre controles. Na lista de providers, setas movem o foco e Enter seleciona.</dd>
          </dl>
          <h2>O que a interface faz</h2>
          <ul className="help-list">
            <li>Orientar a tarefa em execução sem pará-la; o texto chega no próximo passo.</li>
            <li>Interromper a execução e retomar depois, na mesma sessão e concessão.</li>
            <li>Trocar provider/modelo em ponto seguro, com confirmação do core.</li>
            <li>Inspecionar cada tool: argumentos, saída retida, duração e diff de edições.</li>
            <li>Ver testes por execução, com comando, contagens e diagnóstico de falha.</li>
          </ul>
          <h2>Estados da tarefa</h2>
          <ul className="help-states">
            {HELP_STATES.map((entry) => (
              <li key={entry.state}>
                <span className={stateClass(entry.state)}>{stateLabel(entry.state)}</span>
                <span>{entry.meaning}</span>
              </li>
            ))}
          </ul>
          <h2>Limites honestos</h2>
          <p className="meta">Estado “Resultado incerto” não é sucesso: o efeito não foi observado. Retomada pode ser recusada por concessão, orçamento ou estado. A descoberta de modelos depende do provider; ID manual permanece disponível.</p>
          </details>
          <details className="help-guide help-cli">
            <summary>Comandos disponíveis no terminal <span>CLI · fora do chat</span></summary>
            <dl className="command-entries">
              <div><dt><code>lattice status</code></dt><dd>Inspeciona configuração e prontidão local; não é /status da tarefa.</dd></div>
              <div><dt><code>lattice sessions</code></dt><dd>Lista sessões persistidas.</dd></div>
              <div><dt><code>lattice resume &lt;taskId&gt;</code></dt><dd>Solicita retomada sob os limites originais; não inicia o loop sozinho.</dd></div>
              <div><dt><code>lattice run --resume &lt;taskId&gt;</code></dt><dd>Retoma e executa uma tarefa persistida quando permitido.</dd></div>
            </dl>
          </details>
        </div>
      </div>
    </section>
  );
}

function DiffView({ full }: { full: string }): JSX.Element | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(full);
  } catch {
    return null;
  }
  const record = parsed as { beforePreview?: unknown; afterPreview?: unknown; beforePreviewTruncated?: unknown; afterPreviewTruncated?: unknown };
  if (typeof record.beforePreview !== "string" || typeof record.afterPreview !== "string") return null;
  const { lines, truncated } = unifiedDiff(record.beforePreview, record.afterPreview);
  if (lines.length === 0) return null;
  return (
    <section className="inspector-section diff">
      <h3>Diff das prévias retidas</h3>
      {(truncated || record.beforePreviewTruncated === true || record.afterPreviewTruncated === true) && (
        <p className="meta">diff parcial: as prévias retidas têm limite, não o arquivo inteiro</p>
      )}
      <pre className="output" aria-label="Diff do arquivo">
        {lines.map((line, index) => (
          <span key={index} className={line.kind === "add" ? "add" : line.kind === "del" ? "del" : "ctx"}>
            {`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.oldNo ?? ""}:${line.newNo ?? ""} ${line.text}\n`}
          </span>
        ))}
      </pre>
    </section>
  );
}
