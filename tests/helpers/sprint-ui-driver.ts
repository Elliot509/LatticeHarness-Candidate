import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { CdpSession } from "../browser/cdp.js";

export async function evaluate<T>(session: CdpSession, expression: string): Promise<T> {
  const result = await session.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert.equal(result.exceptionDetails, undefined);
  return result.result.value;
}
export async function waitFor(session: CdpSession, expression: string, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await evaluate<boolean>(session, expression))) {
    if (Date.now() > deadline) throw new Error(`UI deadline: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
export async function capture(session: CdpSession, dest: string): Promise<void> {
  const result = await session.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(dest, Buffer.from(result.data, "base64"));
}
export async function driveSprintDemo(session: CdpSession, endpoint: string, shots: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await waitFor(session, `document.querySelector('.newtask') !== null`);
  await capture(session, path.join(shots, "start.png"));
  await evaluate(session, `document.querySelector('.newtask-modelbtn').click()`);
  await waitFor(session, `document.querySelector('.modelpicker select option[value=local]') !== null`);
  await evaluate(session, `(() => { const e = document.querySelector('.modelpicker select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'local'); e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(session, `document.querySelector('.modelpicker')?.textContent.includes('Servidor OpenAI-compatible local') === true`);
  for (const [label, value] of [["Endpoint", endpoint], ["Modelo", "p0-fixture-model"]]) {
    await evaluate(session, `(() => { const e = document.querySelector('input[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  await evaluate(session, `[...document.querySelectorAll('.modelpicker button')].find(e=>e.textContent.trim()==='Usar este modelo').click()`);
  await waitFor(session, `document.querySelector('.newtask-modelconfig') === null`);
  await evaluate(session, `(() => { const e=document.querySelector('#new-task-objective'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Create directory Muse'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await evaluate(session, `document.querySelector('button[aria-label="Iniciar tarefa"]').click()`);
  await waitFor(session, `document.querySelector('.topbar')?.textContent.includes('Concluído') === true`);
  assert.match(await evaluate<string>(session, `document.querySelector('.objective-panel').textContent`), /Create directory Muse/);
  assert.match(await evaluate<string>(session, `document.querySelector('.chat').textContent`), /read/);
  assert.match(await evaluate<string>(session, `document.querySelector('.chat').textContent`), /exec/);
  assert.equal(await evaluate(session, `[...document.querySelectorAll('.notice-row')].some(e => e.textContent.includes('Bloqueio de retomada'))`), false);
  assert.doesNotMatch(await evaluate<string>(session, `document.querySelector('.budgettag').textContent`), /\/50|\/200/);
  assert.equal(await evaluate(session, `getComputedStyle(document.querySelector(".topbar .state")).color !== getComputedStyle(document.querySelector(".topbar .state")).backgroundColor`), true);
  await evaluate(session, `(() => { const e = document.querySelector('.chat'); e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); })()`);
  await evaluate(session, `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Configurações').click()`);
  await waitFor(session, `document.querySelector('.settings') !== null`);
  await evaluate(session, `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Tarefas').click()`);
  await waitFor(session, `document.querySelector('.chat') !== null`);
  assert.equal(await evaluate(session, `document.querySelector('.chat').scrollTop`), 0);
  for (const [theme, width, height] of [["light", 1440, 900], ["light", 900, 700], ["dark", 1440, 900]] as const) {
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate(session, `document.documentElement.scrollWidth <= innerWidth`), true);
    await capture(session, path.join(shots, `completed-${theme}-${width}.png`));
  }
  await session.send("Page.reload");
  await waitFor(session, `document.querySelector('.session') !== null`);
  await evaluate(session, `document.querySelector('.session').click()`);
  await waitFor(session, `document.querySelector('.topbar')?.textContent.includes('Concluído') === true`);
  assert.match(await evaluate<string>(session, `document.querySelector('.chat').textContent`), /read/);
  await capture(session, path.join(shots, "retained.png"));
}
