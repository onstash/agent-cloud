import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const token = process.env.MCP_BEARER_TOKEN;

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8802/mcp");

assert.ok(token, "Set MCP_BEARER_TOKEN");

assert.equal((await fetch(url)).status, 401);

const client = new Client({ name: "offline-bridge-smoke", version: "1.0.0" });

await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

async function command(commandText) {
  const request = { method: "POST", path: "/command", body: { command: commandText } };

  const result = await client.callTool({
    name: "execute",
    arguments: { code: `async () => codemode.request(${JSON.stringify(request)})` },
  });

  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content[0].type, "text");

  return JSON.parse(result.content[0].text);
}

try {
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "execute",
    "search",
  ]);

  const patchResult = await client.callTool({
    name: "execute",
    arguments: {
      code: `async () => codemode.request(${JSON.stringify({ method: "GET", path: "/patch" })})`,
    },
  });

  assert.equal(patchResult.isError, undefined, JSON.stringify(patchResult));
  assert.equal(patchResult.content[0].type, "text");

  const patch = z
    .object({ commit: z.string(), changedFiles: z.array(z.string()), patch: z.string() })
    .parse(JSON.parse(patchResult.content[0].text));

  assert.match(patch.commit, /^[0-9a-f]{40,64}$/);

  const dependency = await command(
    'cd /workspace/snapshot/app && node -e \'console.log(require("zod").z.string().parse("dependency-ok"))\'',
  );

  assert.equal(dependency.exitCode, 0, dependency.output);
  assert.match(dependency.output, /dependency-ok/);

  const tests = await command(
    "cd /workspace/snapshot/app && node --test src/lib/compile-prompt.test.ts",
  );

  assert.equal(tests.exitCode, 0, tests.output);

  const isolation = await command(
    "test ! -S /var/run/docker.sock && test -z \"$(printenv | grep -Ei '^(GH_TOKEN|GITHUB_TOKEN|MCP_BEARER_TOKEN|LOCAL_BROKER_TOKEN)=')\"",
  );

  assert.equal(isolation.exitCode, 0, isolation.output);

  const network = await command(
    "node -e 'fetch(\"https://example.com\", {signal: AbortSignal.timeout(5000)}).then(() => process.exit(1)).catch(() => process.exit(0))'",
  );

  assert.equal(network.exitCode, 0, network.output);
  console.log(
    "MCP patch retrieval, dependency, project test, credential checks, and network probe passed.",
  );
} finally {
  await client.close();
}
