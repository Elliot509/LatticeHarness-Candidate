import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership } from "../../src/storage/db.js";
import { serveLattice } from "../../src/server/server.js";
import { launchChromium, screenshot, type CdpSession } from "./cdp.js";

async function evaluate<T>(session: CdpSession, expression: string): Promise<T> {
  const result = await session.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}

async function waitFor(session: CdpSession, expression: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!(await evaluate<boolean>(session, expression))) {
    if (Date.now() > deadline) throw new Error(`UI condition not met: ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
}

async function input(session: CdpSession, label: string, value: string): Promise<void> {
  await evaluate(session, `(() => {
    const input = document.querySelector('input[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function click(session: CdpSession, text: string, scope = ""): Promise<void> {
  await evaluate(session, `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((button) => button.textContent.trim() === ${JSON.stringify(text)})?.click()`);
}

async function selectProvider(session: CdpSession, name: string): Promise<void> {
  await evaluate(session, `[...document.querySelectorAll('.provider-option')].find((button) => button.querySelector('.provider-option-name')?.textContent.replace('●', '') === ${JSON.stringify(name)})?.click()`);
  await waitFor(session, `document.querySelector('.provider-detail h3')?.textContent === ${JSON.stringify(name)}`);
}

async function viewport(session: CdpSession, width: number, height: number): Promise<void> {
  await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
}

describe("provider master-detail and operational help", () => {
  it("uses real APIs for keys, endpoints, models and custom configuration without presenting future commands as executable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-provider-ui-"));
    const shots = "/tmp/lattice-provider-shots";
    fs.mkdirSync(shots, { recursive: true });
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    const dataDir = path.join(dir, "data");
    const db = openLatticeDb(dataDir);
    claimOwnership(db.raw);
    const observed: Array<{ url: string; auth: string | undefined }> = [];
    let delayed: ServerResponse | null = null;
    const endpoint = createServer((request, response) => {
      observed.push({ url: request.url ?? "", auth: request.headers.authorization });
      if (request.url === "/slow/models") { delayed = response; return; }
      response.writeHead(request.url === "/denied/models" ? 401 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: request.url === "/empty/models" ? [] : [{ id: "modelo-local-1" }, { id: "modelo-local-2" }] }));
    });
    await new Promise<void>((resolve) => { endpoint.listen(0, "127.0.0.1", resolve); });
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("fixture has no port");
    const base = `http://127.0.0.1:${address.port}`;
    const server = await serveLattice({ db: db.raw, workspace, dataDir, assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19003);
    const session = browser.session;
    const snap = async (name: string): Promise<void> => { await screenshot(session, path.join(shots, `${name}.png`)); };
    try {
      await session.send("Page.enable");
      await viewport(session, 1440, 900);
      await session.send("Page.navigate", { url: server.url });
      await waitFor(session, `document.querySelector('.sidebar-nav') !== null`);
      await click(session, "Configurações", ".sidebar-nav");
      await waitFor(session, `document.querySelector('.provider-detail h3')?.textContent === 'OpenAI'`);
      expect(await evaluate(session, `document.querySelectorAll('.provider-detail').length`)).toBe(1);
      expect(await evaluate(session, `document.querySelector('.credential-state').textContent`)).toBe("Não configurada");
      await snap("openai-nao-configurado-1440");
      await input(session, "Endpoint do provider", `${base}/denied`);
      await click(session, "Testar conexão", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-feedback.error') !== null`);
      await snap("erro-conexao-1440");
      await input(session, "Chave de API OpenAI", "fixture-key-1");
      await click(session, "Salvar chave", ".provider-detail");
      await waitFor(session, `document.querySelector('.credential-state')?.textContent === 'Configurada · sessão'`);
      expect(await evaluate(session, `document.querySelector('input[type=password]').value`)).toBe("");
      await input(session, "Endpoint do provider", `${base}/v1`);
      await click(session, "Testar conexão", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-feedback.success') !== null`);
      expect(observed.at(-1)?.auth).toBe("Bearer fixture-key-1");
      await input(session, "Chave de API OpenAI", "fixture-key-2");
      await click(session, "Substituir chave", ".provider-detail");
      await waitFor(session, `document.querySelector('input[type=password]')?.value === '' && [...document.querySelectorAll('.provider-inline-actions button')].some(b => b.textContent === 'Remover chave' && !b.disabled)`);
      await click(session, "Testar conexão", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-feedback.success') !== null`);
      expect(observed.at(-1)?.auth).toBe("Bearer fixture-key-2");
      await snap("openai-configurado-1440");
      await click(session, "Remover chave", ".provider-detail");
      await waitFor(session, `document.querySelector('.credential-state')?.textContent === 'Não configurada'`);
      await click(session, "Testar conexão", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-feedback.success') !== null`);
      expect(observed.at(-1)?.auth).toBeUndefined();

      await evaluate(session, `document.querySelector('.provider-option').focus()`);
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
      expect(await evaluate(session, `document.activeElement.querySelector('.provider-option-name').textContent`)).toBe("OpenRouter");
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await waitFor(session, `document.querySelector('.provider-detail h3')?.textContent === 'OpenRouter'`);
      expect(await evaluate(session, `document.querySelector('.provider-feedback')`)).toBeNull();
      expect(await evaluate(session, `document.querySelector('input[aria-label="Endpoint do provider"]').value`)).toBe("https://openrouter.ai/api/v1");
      const link = await evaluate<{ href: string; target: string; rel: string }>(session, `(() => { const a = document.querySelector('.provider-detail-head a'); return { href: a.href, target: a.target, rel: a.rel }; })()`);
      expect(link).toEqual({ href: "https://openrouter.ai/docs/api/reference", target: "_blank", rel: "noreferrer" });
      await snap("openrouter-1440");

      await selectProvider(session, "Local");
      expect(await evaluate(session, `document.querySelector('.provider-field h4').textContent`)).toContain("opcional");
      await input(session, "Endpoint do provider", `${base}/v1`);
      await snap("local-1440");
      expect(await evaluate(session, `document.querySelector('.provider-credential').open`)).toBe(false);
      await evaluate(session, `document.querySelector('.provider-credential summary').click()`);
      await input(session, "Chave de API Local", "fixture-local-key");
      await click(session, "Salvar chave", ".provider-detail");
      await waitFor(session, `document.querySelector('.credential-state').textContent === 'Configurada · sessão'`);
      await click(session, "Remover chave", ".provider-detail");
      await waitFor(session, `document.querySelector('.credential-state').textContent === 'Não configurada'`);
      await click(session, "Escolher modelo", ".provider-detail");
      await click(session, "Listar modelos", ".modelpicker");
      await waitFor(session, `document.querySelectorAll('.modelrow').length === 2`);
      expect(observed.at(-1)?.url).toBe("/v1/models");
      const beforeRefresh = observed.length;
      await click(session, "Atualizar modelos", ".modelpicker");
      await waitFor(session, `document.querySelectorAll('.modelrow').length === 2`);
      expect(observed.length).toBe(beforeRefresh + 1);
      await input(session, "Buscar modelos", "local-2");
      await waitFor(session, `document.querySelectorAll('.modelrow').length === 1`);
      await click(session, "modelo-local-2", ".modellist");
      await waitFor(session, `document.querySelector('.provider-default')?.textContent.includes('local / modelo-local-2')`);
      const config = await evaluate<{ defaultProviderId: string; defaultModel: string; defaultBaseUrl: string }>(session, `fetch('/api/product-config').then(r => r.json()).then(r => r.config)`);
      expect(config).toMatchObject({ defaultProviderId: "local", defaultModel: "modelo-local-2", defaultBaseUrl: `${base}/v1` });
      await selectProvider(session, "OpenAI");
      await selectProvider(session, "Local");
      expect(await evaluate(session, `document.querySelector('input[aria-label="Endpoint do provider"]').value`)).toBe(`${base}/v1`);

      // Results from an old endpoint must never be presented as results of its replacement.
      await input(session, "Endpoint do provider", `${base}/slow`);
      await click(session, "Testar conexão", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-detail').textContent.includes('Testando…')`);
      const connectionDeadline = Date.now() + 5000;
      while (delayed === null) {
        if (Date.now() > connectionDeadline) throw new Error("Connection test did not reach endpoint");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await input(session, "Endpoint do provider", `${base}/empty`);
      (delayed as ServerResponse).end(JSON.stringify({ data: [{ id: "stale-model" }] }));
      await click(session, "Escolher modelo", ".provider-detail");
      await click(session, "Listar modelos", ".modelpicker");
      await waitFor(session, `document.querySelector('.modelpicker').textContent.includes('não lista modelos')`);
      expect(await evaluate(session, `document.querySelector('.provider-feedback.success')`)).toBeNull();
      await input(session, "Modelo", "modelo-manual");
      await click(session, "Usar este modelo", ".modelpicker");
      await waitFor(session, `document.querySelector('.provider-default').textContent.includes('modelo-manual')`);

      await evaluate(session, `[...document.querySelectorAll('.provider-option')].find(b => b.textContent.includes('+ Custom')).click()`);
      await waitFor(session, `document.querySelector('.provider-custom-form') !== null`);
      await input(session, "Nome do custom", "Gateway de teste");
      await input(session, "Endpoint do custom", `${base}/custom`);
      await click(session, "Salvar custom", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-detail h3')?.textContent === 'Gateway de teste'`);
      expect(await evaluate(session, `document.querySelector('input[aria-label="Endpoint do provider"]').value`)).toBe(`${base}/custom`);
      await click(session, "Testar conexão", ".provider-detail");
      await waitFor(session, `document.querySelector('.provider-feedback.success') !== null`);
      expect(observed.at(-1)?.url).toBe("/custom/models");
      await click(session, "Escolher modelo", ".provider-detail");
      await click(session, "Listar modelos", ".modelpicker");
      await waitFor(session, `document.querySelectorAll('.modelrow').length === 2`);
      await click(session, "modelo-local-1", ".modellist");
      await waitFor(session, `document.querySelector('.provider-default').textContent.includes('custom / modelo-local-1')`);
      expect(await evaluate(session, `document.querySelector('.provider-option.selected .provider-default-mark') !== null`)).toBe(true);
      expect(await evaluate(session, `fetch('/api/product-config').then(r => r.json()).then(r => r.config.defaultBaseUrl)`)).toBe(`${base}/custom`);
      await snap("custom-1440");
      await selectProvider(session, "Local");
      await click(session, "Escolher modelo", ".provider-detail");
      await input(session, "Endpoint do provider", `${base}/slow`);
      delayed = null;
      await click(session, "Listar modelos", ".modelpicker");
      const deadline = Date.now() + 5000;
      while (delayed === null) {
        if (Date.now() > deadline) throw new Error("Discovery did not reach endpoint");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await input(session, "Endpoint do provider", `${base}/v1`);
      (delayed as ServerResponse).end(JSON.stringify({ data: [{ id: "stale-model" }] }));
      await click(session, "Listar modelos", ".modelpicker");
      await waitFor(session, `document.querySelectorAll('.modelrow').length === 2`);
      expect(await evaluate(session, `document.querySelector('.modellist').textContent`)).not.toContain("stale-model");

      for (const [width, height] of [[1200, 800], [900, 700]] as const) {
        await viewport(session, width, height);
        await selectProvider(session, "OpenAI");
        expect(await evaluate(session, `document.querySelectorAll('.provider-detail').length`)).toBe(1);
        expect(await evaluate(session, `document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
        expect(await evaluate(session, `(() => { const r = document.querySelector('.provider-model-head button').getBoundingClientRect(); return r.bottom <= innerHeight && r.right <= innerWidth; })()`)).toBe(true);
        await snap(`providers-${width}`);
      }
      await click(session, "Voltar à tarefa", ".settings-head");
      await waitFor(session, `document.querySelector('.newtask') !== null`);
      await click(session, "Ajuda", ".sidebar-nav");
      await waitFor(session, `document.querySelector('#commands-title') !== null`);
      expect(await evaluate(session, `document.querySelector('.planned-commands').querySelectorAll('button,a,input').length`)).toBe(0);
      expect(await evaluate(session, `document.querySelector('.available-actions').textContent.includes('/model')`)).toBe(false);
      expect(await evaluate(session, `document.querySelector('.commands-caveat').textContent`)).toContain("texto comum");
      expect(await evaluate(session, `document.querySelector('.planned-commands').textContent`)).toContain("/reconcile");
      await snap("ajuda-comandos-900");
      await viewport(session, 1200, 800);
      await snap("ajuda-comandos-1200");
      await viewport(session, 1440, 900);
      await snap("ajuda-comandos-1440");
      await evaluate(session, `document.querySelectorAll('.command-group')[3].open = true; document.querySelectorAll('.command-group')[3].scrollIntoView({block:'center'})`);
      await snap("ajuda-extensoes-1440");
      await click(session, "Voltar à tarefa", ".settings-head");
      await waitFor(session, `document.querySelector('.newtask') !== null`);
    } catch (error) {
      await snap("failure");
      throw error;
    } finally {
      await browser.close();
      await server.close();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => { endpoint.close(() => { resolve(); }); });
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
