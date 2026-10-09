import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership } from "../../src/storage/db.js";
import { saveProductConfig } from "../../src/productConfig.js";
import { serveLattice } from "../../src/server/server.js";
import { contextProvider } from "../helpers/context-provider.js";
import { launchChromium } from "./cdp.js";
import { evaluate, waitFor } from "../helpers/sprint-ui-driver.js";

describe("context indicator in the real browser", () => {
  it("shows actual last input/window/percentage, updates live and survives reload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-context-browser-")); const root = path.join(dir, "project"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "note"), "observed");
    let release = () => {}; const wait = new Promise<void>(resolve => { release = resolve; });
    const fixture = await contextProvider([{ id: "manual/model", context_length: 128000 }], [
      { toolCalls: [{ name: "read", argumentsJson: '{"path":"note"}' }] },
      { text: "Analysis", usage: { prompt_tokens: 2300, completion_tokens: 1000 }, wait },
    ]);
    const data = path.join(dir, "data"); const db = openLatticeDb(data); claimOwnership(db.raw);
    saveProductConfig(data, { schemaVersion: 1, defaultProviderId: "local", defaultModel: "manual/model", defaultBaseUrl: fixture.url, customProviders: [] });
    const server = await serveLattice({ db: db.raw, workspace: root, dataDir: data, assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19007);
    try {
      await browser.session.send("Page.enable"); await browser.session.send("Page.navigate", { url: server.url });
      await waitFor(browser.session, "document.querySelector('.newtask-modelbtn')?.textContent.includes('manual/model') === true");
      await evaluate(browser.session, `(() => {const e=document.querySelector('#new-task-objective');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Leia note e explique.');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await evaluate(browser.session, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').click()");
      await waitFor(browser.session, "document.querySelector('.contexttag')?.textContent === 'Contexto: 1.9k / 128k (1,5%)'");
      expect(await evaluate(browser.session, "document.querySelector('.budgettag summary').textContent")).toBe("Diagnóstico");
      expect(await evaluate(browser.session, "document.querySelector('.topbar').innerText")).not.toContain("tokens observados");
      release();
      await waitFor(browser.session, "document.querySelector('.contexttag')?.textContent === 'Contexto: 2.3k / 128k (1,8%)'");
      await waitFor(browser.session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true");
      for (const width of [1440, 1200, 900]) {
        await browser.session.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
        expect(await evaluate(browser.session, "document.querySelector('.contexttag').getBoundingClientRect().width > 0")).toBe(true);
        expect(await evaluate(browser.session, "document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      }
      await browser.session.send("Page.reload"); await waitFor(browser.session, "document.querySelector('.session') !== null");
      await evaluate(browser.session, "document.querySelector('.session').click()");
      await waitFor(browser.session, "document.querySelector('.contexttag')?.textContent === 'Contexto: 2.3k / 128k (1,8%)'");
      expect(fixture.requests).toHaveLength(2); expect(fixture.catalogReads).toBe(1);
    } finally { release(); await browser.close(); await server.close(); db.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
