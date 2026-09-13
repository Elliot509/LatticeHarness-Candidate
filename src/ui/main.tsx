import { StrictMode, useEffect, useReducer } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api.js";
import { initialState, uiReducer } from "./state.js";
import { Chat, Composer, Detail, Header, HelpView, NewTask, SettingsView, Sidebar } from "./views.js";
import type { UiEvent } from "../server/protocol.js";

const api = createApi("");

function TaskView(): JSX.Element {
  const [state, dispatch] = useReducer(uiReducer, initialState);

  useEffect(() => {
    document.getElementById("root")?.removeAttribute("aria-busy");
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .sessions()
      .then((sessions) => {
        if (!cancelled) {
          dispatch({ type: "sessions", sessions });
          dispatch({ type: "connection", connection: "live" });
        }
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "connection", connection: "error", error: "Não foi possível acessar o servidor local" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const taskId = state.activeTaskId;
    if (taskId === null) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    api
      .snapshot(taskId)
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({ type: "snapshot", snapshot });
        dispatch({ type: "connection", connection: "live" });
        unsubscribe = api.subscribe(
          taskId,
          (event: UiEvent) => {
            if (event.kind === "resync") {
              api
                .snapshot(taskId)
                .then((fresh) => {
                  if (!cancelled) dispatch({ type: "snapshot", snapshot: fresh });
                })
                .catch(() => {
                  if (!cancelled) dispatch({ type: "request-resync" });
                });
              return;
            }
            dispatch({ type: "event", event });
          },
          (status) => {
            if (!cancelled) dispatch({ type: "connection", connection: status === "live" ? "live" : "reconnecting" });
          },
        );
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "connection", connection: "error", error: "não foi possível abrir a tarefa" });
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [state.activeTaskId]);

  useEffect(() => {
    if (!state.needsResync || state.activeTaskId === null) return;
    const taskId = state.activeTaskId;
    let cancelled = false;
    api
      .snapshot(taskId)
      .then((snapshot) => {
        if (!cancelled) dispatch({ type: "snapshot", snapshot });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state.needsResync, state.activeTaskId]);

  return (
    <div className="app">
      <Sidebar state={state} dispatch={dispatch} />
      <div className={state.activeTaskId === null || state.view !== "task" ? "main landing-main" : "main"}>
        {state.activeTaskId !== null && state.view === "task" && <Header api={api} state={state} />}
        {state.view === "settings" ? (
          <div className="layout">
            <main className="center">
              <div className="reading page-reading">
                <SettingsView api={api} state={state} dispatch={dispatch} />
              </div>
            </main>
          </div>
        ) : state.view === "help" ? (
          <div className="layout">
            <main className="center">
              <div className="reading page-reading">
                <HelpView state={state} dispatch={dispatch} />
              </div>
            </main>
          </div>
        ) : (
        <div className="layout">
          <main className="center">
            {state.task === null ? (
              <div className="reading">
                {state.activeTaskId === null ? (
                  <NewTask api={api} state={state} dispatch={dispatch} />
                ) : (
                  <div className="opening-task" role="status" aria-label="Abrindo tarefa">
                    <span>Abrindo tarefa</span>
                    <span className="opening-line" />
                    <span className="opening-line short" />
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="reading">
                  <Chat state={state} dispatch={dispatch} />
                </div>
                <Composer api={api} state={state} dispatch={dispatch} />
              </>
            )}
            {state.connection === "reconnecting" && (
              <p className="conn" role="status">
                Reconectando ao runtime local; a tarefa continua executando.
              </p>
            )}
            {state.needsResync && (
              <p className="conn resync" role="status">
                Atualizando a projeção da tarefa após uma lacuna de eventos.
              </p>
            )}
            {state.connection === "error" && state.error !== null && (
              <p className="conn error" role="alert">
                {state.error}
              </p>
            )}
          </main>
          {state.detailId !== null && <Detail api={api} state={state} dispatch={dispatch} />}
        </div>
        )}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <TaskView />
  </StrictMode>,
);
