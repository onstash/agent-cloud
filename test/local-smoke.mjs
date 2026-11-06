import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8799/mcp");

const token = process.env.MCP_BEARER_TOKEN;

assert.ok(token, "Set MCP_BEARER_TOKEN to the local test token");

assert.equal((await fetch(url)).status, 401);

const client = new Client({ name: "cloud-coding-smoke", version: "1.0.0" });

await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

async function call(name, code) {
  const result = await client.callTool({ name, arguments: { code } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content[0].type, "text");

  return JSON.parse(result.content[0].text);
}

async function command(value) {
  const request = { method: "POST", path: "/command", body: { command: value } };

  return call("execute", `async () => codemode.request(${JSON.stringify(request)})`);
}

try {
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "execute",
    "search",
  ]);
  assert.deepEqual(
    (await call("search", "async () => Object.keys((await codemode.spec()).paths)")).sort(),
    ["/cleanup", "/command"],
  );
  await call("execute", 'async () => codemode.request({method:"POST",path:"/cleanup"})');
  const before = await command("node --test total.test.ts");
  assert.equal(before.exitCode, 1);
  assert.match(before.output, /fail 1/);
  assert.equal((await command("sed -i 's/total - price/total + price/' total.ts")).exitCode, 0);
  const after = await command("node --test total.test.ts");
  assert.equal(after.exitCode, 0);
  assert.match(after.output, /pass 2/);
  const patch = await command("diff -u /baseline/total.ts /workspace/total.ts");
  assert.equal(patch.exitCode, 1);
  assert.match(patch.output, /total \+ price/);

  const network = await command(
    "node -e 'fetch(\"https://example.com\", {signal: AbortSignal.timeout(5000)}).then(() => process.exit(1)).catch(() => process.exit(0))'",
  );

  assert.equal(network.exitCode, 0, "The unauthorized network request must fail");
  console.log("MCP authentication, discovery, fixture fix, patch, and network denial passed.");
} finally {
  await call("execute", 'async () => codemode.request({method:"POST",path:"/cleanup"})');
  await client.close();
}
