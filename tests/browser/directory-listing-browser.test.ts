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

describe("listing incident through the real browser form", () => {
  it("delivers the real entries, completes without redundant dispatches and reopens with actual context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-listing-browser-")); const root = path.join(dir, "project"); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "README.md"), "fictitious"); fs.writeFileSync(path.join(root, ".hidden"), "fictitious"); fs.mkdirSync(path.join(root, "subdir"));
    const fixture = await contextProvider([{ id: "listing-fixture", context_length: 128000 }], [{ toolCalls: [{ name: "read", argumentsJson: '{"kind":"directory","path":"."}' }], usage: { prompt_tokens: 1900, completion_tokens: 42 } }]);
    const data = path.join(dir, "data"); const db = openLatticeDb(data); claimOwnership(db.raw);
    saveProductConfig(data, { schemaVersion: 1, defaultProviderId: "local", defaultModel: "listing-fixture", defaultBaseUrl: fixture.url, customProviders: [] });
    const server = await serveLattice({ db: db.raw, workspace: root, dataDir: data, assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19008);
    try {
      await browser.session.send("Page.enable"); await browser.session.send("Page.navigate", { url: server.url });
      await waitFor(browser.session, "document.querySelector('.newtask-modelbtn')?.textContent.includes('listing-fixture') === true");
      await evaluate(browser.session, `(() => {const e=document.querySelector('#new-task-objective');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Me liste tudo que está nessa pasta.');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await evaluate(browser.session, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').click()");
      await waitFor(browser.session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true");
      expect(await evaluate(browser.session, "document.querySelector('.message-row.agent .text').textContent")).toContain('"README.md" [file]');
      expect(await evaluate(browser.session, "document.querySelector('.message-row.agent .text').textContent")).toContain('".hidden" [file]');
      expect(await evaluate(browser.session, "document.querySelector('.message-row.agent .text').textContent")).toContain('"subdir" [directory]');
      await waitFor(browser.session, "document.querySelector('.contexttag')?.textContent === 'Contexto: 1.9k / 128k (1,5%)'");
      expect(fixture.requests).toHaveLength(1);
      await browser.session.send("Page.reload"); await waitFor(browser.session, "document.querySelector('.session') !== null"); await evaluate(browser.session, "document.querySelector('.session').click()");
      await waitFor(browser.session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true");
      expect(await evaluate(browser.session, "document.querySelector('.message-row.agent .text').textContent")).toContain("Todas as 3 entradas");
      expect(await evaluate(browser.session, "document.querySelector('.contexttag').textContent")).toBe("Contexto: 1.9k / 128k (1,5%)"); expect(fixture.requests).toHaveLength(1);
    } finally { await browser.close(); await server.close(); db.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
