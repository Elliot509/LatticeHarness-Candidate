// P0 fixture provider server: a deterministic local OpenAI-compatible
// endpoint for packaged tests. Serves scripted chat/completions and a
// models listing. TEST INFRASTRUCTURE ONLY: never bundled into the desktop
// app, never reachable from production code, never a default provider.
import http from "node:http";

export interface FixtureStep {
  text?: string;
  toolCalls?: Array<{ name: string; argumentsJson?: string }>;
}

export interface FixtureServer {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
}

export async function startFixtureProvider(script: FixtureStep[]): Promise<FixtureServer> {
  const requests: string[] = [];
  let cursor = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "p0-fixture-model", object: "model" }] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        requests.push(body);
        const step = script[cursor];
        cursor += 1;
        if (step === undefined) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "fixture script exhausted" } }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: `fixture-${cursor}`,
            model: "p0-fixture-model",
            choices: [
              {
                message: {
                  content: step.text ?? "",
                  tool_calls: (step.toolCalls ?? []).map((call, index) => ({
                    id: `fixture-call-${cursor}-${index}`,
                    type: "function",
                    function: { name: call.name, arguments: call.argumentsJson ?? "{}" },
                  })),
                },
                finish_reason: (step.toolCalls ?? []).length > 0 ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") resolve(address.port);
      else reject(new Error("could not bind fixture server"));
    });
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      }),
  };
}
