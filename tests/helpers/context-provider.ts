import http from "node:http";

export interface ContextStep {
  text?: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  toolCalls?: Array<{ name: string; argumentsJson: string }>;
  wait?: Promise<void>;
}

// Deterministic loopback provider; no external API or paid inference.
export async function contextProvider(models: unknown[], steps: ContextStep[] = []) {
  const requests: Array<{ model: string }> = [];
  let catalogReads = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      catalogReads++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: models })); return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    let body = ""; req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      const request = JSON.parse(body) as { model: string }; requests.push(request);
      const step = steps[requests.length - 1];
      if (step === undefined) { res.writeHead(500); res.end(); return; }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: `fixture-${requests.length}`, model: step.model ?? request.model,
        choices: [{ message: { content: step.text ?? "", tool_calls: (step.toolCalls ?? []).map((t, i) => ({ id: `call-${i}`, type: "function", function: { name: t.name, arguments: t.argumentsJson } })) } }],
        usage: step.usage === undefined ? { prompt_tokens: 1900, completion_tokens: 42 } : step.usage }));
      };
      if (step.wait === undefined) send(); else void step.wait.then(send);
    });
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("fixture bind failed");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests, get catalogReads() { return catalogReads; },
    close: () => new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); server.closeAllConnections(); }) };
}
