import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership } from "../../src/storage/db.js";
import { serveLattice } from "../../src/server/server.js";
import { saveProductConfig } from "../../src/productConfig.js";
import { startFixtureProvider } from "../helpers/fixture-provider.js";
import { evaluate, waitFor } from "../helpers/sprint-ui-driver.js";
import { launchChromium } from "./cdp.js";

describe("automatic filesystem acceptance from the real browser form", () => {
  it("submits the incident objective with blank acceptance and completes without further requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-filesystem-browser-"));
    const root = path.join(dir, "project"); fs.mkdirSync(root);
    const data = path.join(dir, "data"); const db = openLatticeDb(data); claimOwnership(db.raw);
    const fixture = await startFixtureProvider([
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "console.log(require('fs').readdirSync('.'))"] }) }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "require('fs').mkdirSync('Python');console.log('READY:Python-exists')"] }) }] },
      { text: "Must not dispatch" },
    ]);
    saveProductConfig(data, { schemaVersion: 1, defaultProviderId: "local", defaultModel: "fixture", defaultBaseUrl: fixture.url, customProviders: [] });
    const server = await serveLattice({ db: db.raw, workspace: root, dataDir: data, assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19006);
    try {
      await browser.session.send("Page.enable"); await browser.session.send("Page.navigate", { url: server.url });
      await waitFor(browser.session, "document.querySelector('.newtask-modelbtn')?.textContent.includes('fixture') === true");
      const objective = 'Crie uma pasta chamada "Python" dentro desse lugar.';
      await evaluate(browser.session, `(() => { const e=document.querySelector('#new-task-objective');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(objective)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await evaluate(browser.session, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').click()");
      await waitFor(browser.session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true");
      expect(fixture.requests).toHaveLength(2);
      const row = db.raw.prepare("SELECT document FROM contracts").get() as { document: string };
      expect(JSON.parse(row.document)).toMatchObject({ objective, acceptanceCriteria: ["directory-exists:Python"] });
      const policy = db.raw.prepare("SELECT payload FROM events WHERE kind='acceptance-policy'").get() as { payload: string };
      expect(JSON.parse(policy.payload)).toMatchObject({ source: "default" });
      expect(fs.statSync(path.join(root, "Python")).isDirectory()).toBe(true);
      await browser.session.send("Page.reload");
      await waitFor(browser.session, "document.querySelector('.session') !== null");
      await evaluate(browser.session, "document.querySelector('.session').click()");
      await waitFor(browser.session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true");
      expect(fixture.requests).toHaveLength(2);
    } finally { await browser.close(); await server.close(); await fixture.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
