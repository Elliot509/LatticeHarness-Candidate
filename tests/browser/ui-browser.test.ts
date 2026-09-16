import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership, type LatticeDb } from "../../src/storage/db.js";
import { serveLattice, type LatticeServer } from "../../src/server/server.js";
import { TaskManager } from "../../src/server/tasks.js";
import { createContract } from "../../src/runtime/contract.js";
import { runTaskLoop } from "../../src/runtime/loop.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { buildToolset } from "../../src/tools/registry.js";
import { ProcessSupervisor } from "../../src/tools/process.js";
import { VerifyLedger, summarizeExecResult } from "../../src/runtime/verify.js";
import type { TaskSurface } from "../../src/context/compiler.js";
import { CdpSession, findChromium, launchChromium, screenshot } from "./cdp.js";

const FIXTURE = path.resolve(__dirname, "../../fixtures/bug-prices");

let dirs: string[] = [];
let handles: LatticeDb[] = [];
let servers: LatticeServer[] = [];
afterEach(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      // Best effort cleanup.
    }
  }
  servers = [];
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Best effort cleanup.
    }
  }
  handles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function textOf(session: CdpSession, selector: string): Promise<string> {  const result = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`,
    returnByValue: true,
  });
  return typeof result.result.value === "string" ? result.result.value : "";
}

async function countOf(session: CdpSession, selector: string): Promise<number> {
  const result = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
    expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    returnByValue: true,
  });
  return typeof result.result.value === "number" ? result.result.value : -1;
}

async function waitFor(session: CdpSession, expression: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.result.value === true) return;
    if (Date.now() >= deadline) throw new Error(`condition not met: ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("browser ui", () => {
  it("renders a real task and drives steering by keyboard", async () => {
    const binary = findChromium();
    if (binary === null) {
      console.warn("chromium not available; browser test skipped");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-browser-"));
    dirs.push(dir);
    const workspace = path.join(dir, "project");
    copyDir(FIXTURE, workspace);
    const opened = openLatticeDb(path.join(dir, "data"));
    handles.push(opened);
    claimOwnership(opened.raw);
    const tasks = new TaskManager(opened.raw, workspace);

    const created = tasks.handleCommand({
      commandId: "browser-create",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix the bulk discount bug", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    if (!created.accepted || created.taskId === "") throw new Error("create-task denied");
    const taskId = created.taskId;

    const sumPath = path.join(workspace, "src", "sum.js");
    const version = `sha256:${createHash("sha256").update(fs.readFileSync(sumPath)).digest("hex").slice(0, 16)}`;
    const nodeExe = process.execPath;
    const provider = new FakeProvider([
      { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"discount\"}" }] },
      { toolCalls: [{ name: "read", argumentsJson: "{\"path\":\"src/sum.js\"}" }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
      {
        toolCalls: [
          {
            name: "edit",
            argumentsJson: JSON.stringify({
              kind: "replace",
              path: "src/sum.js",
              expectedVersion: version,
              oldText: "  return items.reduce((sum, item) => {\n    const line = item.price * item.qty;\n    const discount = item.price > 50 ? item.price * 0.1 : 0;\n    return sum + line - discount;\n  }, 0);",
              newText: "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = subtotal > 100 ? subtotal * 0.1 : 0;\n  return subtotal - discount;",
            }),
          },
        ],
      },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
      { text: "Fixed and verified." },
    ]);
    const contract = createContract({
      taskId,
      rootId: `root-${taskId}`,
      objective: "Fix the bulk discount bug",
      scope: [workspace],
      acceptanceCriteria: ["project test suite passes"],
      obligations: ["preserve human files"],
      grants: [
        { subject: "agent", operations: ["search", "read", "edit", "exec", "model.invoke"], targets: [workspace], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: ["publish"],
      realm: "local-trusted",
      allowedProvider: "openai",
      allowedModel: "m1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "browser test",
    });
    const ledger = new VerifyLedger();
    const surface: TaskSurface = {
      objective: contract.objective,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      grants: ["tools under workspace"],
      prohibitions: [...contract.prohibitions],
      obligations: [...contract.obligations],
      unknowns: [],
      humanDecisions: [],
      versions: [],
      lastError: null,
    };
    const supervisor = new ProcessSupervisor(workspace);
    const tools = buildToolset({ supervisor });
    const execEntry = tools.find((entry) => entry.name === "exec");
    if (execEntry === undefined) throw new Error("exec tool missing");
    const innerRun = execEntry.run.bind(execEntry);
    execEntry.run = async (argsJson, context) => {
      const startedAt = Date.now();
      const out = await innerRun(argsJson, context);
      ledger.record(summarizeExecResult("verify", context.workspaceRoot, out.result, Date.now() - startedAt));
      return out;
    };
    const stop = await runTaskLoop({
      db: opened.raw,
      provider,
      model: "m1",
      contract,
      sessionId: "session-browser-1",
      runId: "run-browser-1",
      taskSurface: surface,
      tools,
      toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 30_000 },
      ownerGeneration: 1,
      grantedCalls: 50,
      grantedTokens: 200_000,
      maxIterations: 12,
      acceptanceVerifiers: [() => ledger.check()],
    });
    await supervisor.close();
    expect(stop.decision).toBe("STOP");

    const server = await serveLattice({
      db: opened.raw,
      workspace,
      assetRoot: path.resolve(__dirname, "../../dist/ui"),
    });
    servers.push(server);

    const browser = await launchChromium(19001);
    try {
      const session = browser.session;
      await session.send("Page.enable", {});
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await session.send("Page.navigate", { url: server.url });
      await waitFor(session, `document.querySelector(".newtask h1")?.textContent === "O que vamos construir?"`);
      const landing = await textOf(session, ".newtask");
      expect(landing).toContain("Pasta");
      expect(landing).toContain("Modelo");
      expect(landing).not.toContain("Workspace");
      expect(await textOf(session, ".sidebar")).toContain("Nova tarefa");
      expect(await countOf(session, ".newtask-modelconfig")).toBe(0);

      const landingGeometry = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `(() => {
          const sidebar = document.querySelector(".sidebar");
          const composer = document.querySelector(".newtask-composer");
          const main = document.querySelector(".landing-main");
          if (!(sidebar instanceof HTMLElement) || !(composer instanceof HTMLElement) || !(main instanceof HTMLElement)) return null;
          const sidebarRect = sidebar.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          const mainRect = main.getBoundingClientRect();
          return {
            sidebarWidth: sidebarRect.width,
            composerWidth: composerRect.width,
            centeredDelta: Math.round(Math.abs((composerRect.left + composerRect.width / 2) - (mainRect.left + mainRect.width / 2))),
            noLandingTopbar: document.querySelector(".topbar") === null,
          };
        })()`,
        returnByValue: true,
      });
      expect(landingGeometry.result.value).toEqual({ sidebarWidth: 264, composerWidth: 760, centeredDelta: 0, noLandingTopbar: true });
      await screenshot(session, path.join(dir, "landing-1440.png"));

      await session.send("Runtime.evaluate", { expression: `document.querySelector(".newtaskbtn")?.click()` });
      await waitFor(session, `document.activeElement?.id === "new-task-objective"`);
      await session.send("Runtime.evaluate", { expression: `document.querySelector(".newtask-modelbtn")?.click()` });
      await waitFor(session, `document.querySelector(".newtask-modelconfig") !== null && document.activeElement?.getAttribute("aria-label") === "Provedor"`);
      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector('.modelpicker input[aria-label="Endpoint"]');
          if (!(input instanceof HTMLInputElement)) return;
          input.focus();
          document.execCommand("insertText", false, "http://127.0.0.1:9/v1");
        })()`,
      });
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".modelpicker-actions button")].find((b) => b.textContent?.trim() === "Listar modelos")?.click()`,
      });
      await waitFor(session, `document.querySelector(".modelpicker")?.textContent?.includes("Listagem indisponível") === true`);
      for (const width of [1440, 900]) {
        await session.send("Emulation.setDeviceMetricsOverride", { width, height: width === 1440 ? 900 : 700, deviceScaleFactor: 1, mobile: false });
        const panelBounds = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
          expression: `(() => {
            const panel = document.querySelector(".newtask-modelconfig").getBoundingClientRect();
            return panel.top >= 0 && panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight;
          })()`, returnByValue: true,
        });
        expect(panelBounds.result.value).toBe(true);
        await screenshot(session, path.join(dir, `landing-model-config-${width}.png`));
      }
      await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await waitFor(session, `document.querySelector(".newtask-modelconfig") === null`);
      await session.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
      await screenshot(session, path.join(dir, "landing-900.png"));
      await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

      await session.send("Runtime.evaluate", { expression: `document.querySelector(".workspace-contextbtn")?.click()` });
      await waitFor(session, `document.querySelector("#new-task-workspace-picker") !== null`);
      await waitFor(session, `document.querySelector(".workspacepicker")?.textContent?.includes("src") === true`);
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await waitFor(session, `document.querySelector("#new-task-workspace-picker") === null`);

      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".sidebar-nav .navitem")].find((b) => b.textContent?.includes("Configurações"))?.click()`,
      });
      await waitFor(session, `document.querySelector("#settings-title")?.textContent === "Configurações"`);
      await waitFor(session, `document.querySelector(".provider-detail h3")?.textContent === "OpenAI"`);
      const settingsBody = await textOf(session, ".settings-content");
      expect(settingsBody).toContain("Padrão atual");
      expect(settingsBody).toContain("OpenAI");
      await screenshot(session, path.join(dir, "settings-1440.png"));
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".settings-head button")].find((b) => b.textContent?.trim() === "Voltar à tarefa")?.click()`,
      });
      await waitFor(session, `document.querySelector(".newtask") !== null`);

      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".sidebar-nav .navitem")].find((b) => b.textContent?.includes("Ajuda"))?.click()`,
      });
      await waitFor(session, `document.querySelector("#help-title")?.textContent === "Ajuda"`);
      const helpBody = await textOf(session, ".help-content");
      expect(helpBody).toContain("Atalhos de teclado");
      expect(helpBody).toContain("Resultado incerto");
      await screenshot(session, path.join(dir, "ajuda-1440.png"));
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".settings-head button")].find((b) => b.textContent?.trim() === "Voltar à tarefa")?.click()`,
      });
      await waitFor(session, `document.querySelector(".newtask") !== null`);

      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".sidebar-nav .navitem")].find((b) => b.textContent?.includes("Configurações"))?.click()`,
      });
      await waitFor(session, `document.querySelector("#settings-title")?.textContent === "Configurações"`);
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".settings-navitem")].find((b) => b.textContent?.trim() === "Geral")?.click()`,
      });
      await waitFor(session, `[...document.querySelectorAll(".settings-card h3")].some((h) => h.textContent === "Envio com Enter")`);
      await screenshot(session, path.join(dir, "settings-geral-1440.png"));
      await session.send("Runtime.evaluate", {
        expression: `document.querySelector('.settings-check input[type="checkbox"]')?.click()`,
      });
      await waitFor(session, `window.localStorage.getItem("lattice.sendOnEnter") === "0"`);
      await session.send("Page.navigate", { url: server.url });
      await waitFor(session, `document.querySelector(".newtask") !== null`);
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".sidebar-nav .navitem")].find((b) => b.textContent?.includes("Configurações"))?.click()`,
      });
      await waitFor(session, `document.querySelector("#settings-title")?.textContent === "Configurações"`);
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".settings-navitem")].find((b) => b.textContent?.trim() === "Geral")?.click()`,
      });
      await waitFor(session, `document.querySelector('.settings-check input[type="checkbox"]') !== null`);
      const enterPersisted = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.querySelector('.settings-check input[type="checkbox"]')?.checked === false`,
        returnByValue: true,
      });
      expect(enterPersisted.result.value).toBe(true);
      await session.send("Runtime.evaluate", {
        expression: `document.querySelector('.settings-check input[type="checkbox"]')?.click()`,
      });
      await waitFor(session, `window.localStorage.getItem("lattice.sendOnEnter") === "1"`);
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".settings-navitem")].find((b) => b.textContent?.trim() === "Providers")?.click()`,
      });
      await waitFor(session, `[...document.querySelectorAll(".provider-detail h3")].some((h) => h.textContent?.includes("OpenAI"))`);
      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector('.provider-detail input[type="password"]');
          if (!(input instanceof HTMLInputElement)) return;
          input.focus();
          document.execCommand("insertText", false, "sk-test-secret-that-must-not-leak");
        })()`,
      });
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".provider-detail button")].find((b) => b.textContent?.trim() === "Salvar chave")?.click()`,
      });
      await waitFor(session, `document.querySelector(".settings-content")?.textContent?.includes("Credencial salva em memória") === true`);
      const secretState = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `(() => ({
          cleared: document.querySelector('.provider-detail input[type="password"]')?.value === "",
          leaked: document.querySelector(".settings-content")?.textContent?.includes("sk-test-secret-that-must-not-leak") === true,
        }))()`,
        returnByValue: true,
      });
      expect(secretState.result.value).toEqual({ cleared: true, leaked: false });
      await session.send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".settings-head button")].find((b) => b.textContent?.trim() === "Voltar à tarefa")?.click()`,
      });
      await waitFor(session, `document.querySelector(".newtask") !== null`);

      await waitFor(session, `document.querySelector(".session") !== null`);
      const sessions = await textOf(session, ".sidebar");
      expect(sessions).toContain("Fix the bulk discount bug");

      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector(".sidebar-search input");
          if (!(input instanceof HTMLInputElement)) return;
          input.focus();
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, "zzz-sem-correspondencia");
        })()`,
      });
      await waitFor(session, `document.querySelector(".sessionlist")?.textContent?.includes("Nenhuma sessão corresponde") === true`);
      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector(".sidebar-search input");
          if (!(input instanceof HTMLInputElement)) return;
          input.focus();
          document.execCommand("selectAll", false, undefined);
          document.execCommand("delete", false, undefined);
        })()`,
      });
      await waitFor(session, `document.querySelector(".session") !== null`);

      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".session")?.click()`,
      });
      await waitFor(session, `document.querySelector(".topbar")?.textContent?.includes("Lattice Agent") === true`);
      await waitFor(session, `document.querySelectorAll(".toolrow").length >= 5`);
      const toolCount = await countOf(session, ".toolrow");
      expect(toolCount).toBeGreaterThanOrEqual(5);
      const chat = await textOf(session, ".chat");
      expect(chat).toContain("search");

      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".toolrow-head")?.click()`,
      });
      await waitFor(session, `document.querySelector(".detail") !== null`);
      const detail = await textOf(session, ".detail");
      expect(detail.length).toBeGreaterThan(0);

      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await screenshot(session, path.join(dir, "shot-1440.png"));

      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".model-button")?.click()`,
      });
      await waitFor(session, `document.querySelector(".modelconfig") !== null`);
      const modelFocus = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.activeElement?.getAttribute("aria-label") ?? ""`,
        returnByValue: true,
      });
      expect(modelFocus.result.value).toBe("Provedor");
      await screenshot(session, path.join(dir, "model-config-1440.png"));
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await waitFor(session, `document.querySelector(".modelconfig") === null`);
      const modelFocusReturned = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.activeElement?.getAttribute("aria-label") ?? ""`,
        returnByValue: true,
      });
      expect(modelFocusReturned.result.value).toContain("Configurar modelo");

      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const name = [...document.querySelectorAll(".toolname")].find((element) => element.textContent === "edit");
          const row = name?.closest("button");
          if (row instanceof HTMLButtonElement) row.click();
        })()`,
      });
      await waitFor(session, `document.querySelector(".detail-title")?.textContent === "edit" && document.querySelector(".diff") !== null`);
      await screenshot(session, path.join(dir, "edit-detail-1440.png"));

      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".composer textarea")?.focus()`,
      });
      const focused = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.activeElement?.getAttribute("aria-label") ?? ""`,
        returnByValue: true,
      });
      expect(focused.result.value).toBe("Mensagem para a tarefa");
      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const ta = document.querySelector(".composer textarea");
          ta?.focus();
          return document.execCommand("insertText", false, "Double-check the edge case");
        })()`,
      });
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await waitFor(session, `document.querySelector(".center")?.textContent?.includes("Double-check the edge case") === true`);
      const after = await textOf(session, ".center");
      expect(after).toContain("Double-check the edge case");

      const noHScroll = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.documentElement.scrollWidth <= window.innerWidth`,
        returnByValue: true,
      });
      expect(noHScroll.result.value).toBe(true);

      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 900,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await screenshot(session, path.join(dir, "shot-900.png"));
      const narrowHScroll = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.documentElement.scrollWidth <= window.innerWidth`,
        returnByValue: true,
      });
      expect(narrowHScroll.result.value).toBe(true);
      const narrowLayout = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `(() => {
          const detail = document.querySelector(".detail");
          const composer = document.querySelector(".composer");
          const center = document.querySelector(".center");
          if (!(detail instanceof HTMLElement) || !(composer instanceof HTMLElement) || !(center instanceof HTMLElement)) return null;
          const composerRect = composer.getBoundingClientRect();
          return {
            detailPosition: getComputedStyle(detail).position,
            centerKeepsWorkingHeight: center.getBoundingClientRect().height >= 600,
            composerVisible: composerRect.top < window.innerHeight && composerRect.bottom <= window.innerHeight,
            composerUncovered: (() => {
              const button = composer.querySelector("button");
              const rect = button.getBoundingClientRect();
              return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            })(),
          };
        })()`,
        returnByValue: true,
      });
      expect(narrowLayout.result.value).toEqual({ detailPosition: "absolute", centerKeepsWorkingHeight: true, composerVisible: true, composerUncovered: true });

      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".detail-head button")?.click()`,
      });
      await waitFor(session, `document.querySelector(".detail") === null`);
      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".railhead button")?.click()`,
      });
      await waitFor(session, `document.querySelector(".sidebar")?.classList.contains("collapsed") === true`);
      expect(await textOf(session, ".topbar")).toContain("Lattice Agent");
      // 1440×900 at 200% zoom has a 720×450 CSS layout viewport.
      await session.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
      const zoomControls = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `(() => [...document.querySelectorAll(".composer button, .rail-toggle, .model-button")].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        }) && document.documentElement.scrollWidth <= innerWidth)()`, returnByValue: true,
      });
      expect(zoomControls.result.value).toBe(true);
      await screenshot(session, path.join(dir, "zoom-200-equivalent.png"));
      await session.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".railhead button")?.click()`,
      });
      await waitFor(session, `document.querySelector(".sidebar")?.classList.contains("collapsed") === false`);

      const toolsBefore = await countOf(session, ".toolrow");
      await session.send("Page.navigate", { url: server.url });
      await waitFor(session, `document.querySelector(".session") !== null`);
      await session.send("Runtime.evaluate", {
        expression: `document.querySelector(".session")?.click()`,
      });
      await waitFor(session, `document.querySelectorAll(".toolrow").length >= ${toolsBefore}`);
      expect(await countOf(session, ".toolrow")).toBe(toolsBefore);
      const reloaded = await textOf(session, ".center");
      expect(reloaded).toContain("Double-check the edge case");

      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const ta = document.querySelector(".composer textarea");
          ta?.focus();
          document.execCommand("insertText", false, "line one");
        })()`,
      });
      await waitFor(session, `document.querySelector(".composer textarea")?.value === "line one"`);
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const draftKept = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.querySelector(".composer textarea")?.value ?? ""`,
        returnByValue: true,
      });
      expect(String(draftKept.result.value)).toContain("line one");

      await session.send("Runtime.evaluate", {
        expression: `(() => {
          const ta = document.querySelector(".composer textarea");
          ta?.focus();
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, "<script>window.__pwned=1</script><img src=x onerror=window.__pwned=1>");
        })()`,
      });
      await waitFor(session, `document.querySelector(".composer textarea")?.value?.includes("<script>") === true`);
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await waitFor(session, `document.querySelector(".chat")?.textContent?.includes("<script>") === true`);
      const scripts = await countOf(session, ".chat script");
      expect(scripts).toBe(0);
      const pwned = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `window.__pwned ?? "absent"`,
        returnByValue: true,
      });
      expect(pwned.result.value).toBe("absent");

      const shots = [
        path.join(dir, "landing-1440.png"),
        path.join(dir, "landing-900.png"),
        path.join(dir, "landing-model-config-900.png"),
        path.join(dir, "landing-model-config-1440.png"),
        path.join(dir, "settings-1440.png"),
        path.join(dir, "settings-geral-1440.png"),
        path.join(dir, "ajuda-1440.png"),
        path.join(dir, "shot-1440.png"),
        path.join(dir, "shot-900.png"),
        path.join(dir, "zoom-200-equivalent.png"),
        path.join(dir, "model-config-1440.png"),
        path.join(dir, "edit-detail-1440.png"),
      ];
      for (const shot of shots) expect(fs.existsSync(shot)).toBe(true);
      const dest = "/tmp/lattice-shots";
      fs.mkdirSync(dest, { recursive: true });
      for (const shot of shots) fs.copyFileSync(shot, path.join(dest, path.basename(shot)));
    } finally {
      await browser.close();
    }
  }, 120_000);
});
