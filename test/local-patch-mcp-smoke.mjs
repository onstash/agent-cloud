import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { validPath } from "../scripts/snapshot.mjs";

const token = process.env.MCP_BEARER_TOKEN;

const path = process.env.PATCH_SMOKE_PATH ?? "src/file.ts";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8802/mcp");

const marker = "// cloud-coding patch handoff smoke";

assert.ok(token, "Set MCP_BEARER_TOKEN");

assert.ok(
  validPath(path) && path.endsWith(".ts"),
  "Set PATCH_SMOKE_PATH to an allowlisted TypeScript file",
);

assert.equal((await fetch(url)).status, 401);

const client = new Client({ name: "local-patch-smoke", version: "1.0.0" });

await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

async function execute(request) {
  const result = await client.callTool({
    name: "execute",
    arguments: { code: `async () => codemode.request(${JSON.stringify(request)})` },
  });

  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content[0].type, "text");

  return JSON.parse(result.content[0].text);
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

try {
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "execute",
    "search",
  ]);

  const file = `/workspace/snapshot/${path}`;
  const script = `const fs=require('node:fs');const p=${JSON.stringify(file)};const marker=${JSON.stringify(marker)};if(!fs.readFileSync(p,'utf8').includes(marker))fs.appendFileSync(p,'\\n'+marker+'\\n');`;

  const command = await execute({
    method: "POST",
    path: "/command",
    body: { command: `node -e ${quote(script)}` },
  });

  assert.equal(command.exitCode, 0, command.output);

  const patch = z
    .object({ commit: z.string(), changedFiles: z.array(z.string()), patch: z.string() })
    .parse(await execute({ method: "GET", path: "/patch" }));

  assert.ok(patch.changedFiles.includes(path));
  assert.ok(patch.patch.includes(`+${marker}`));

  const repository = process.env.PATCH_SMOKE_REPOSITORY;

  if (repository) {
    execFileSync("git", ["-C", repository, "apply", "--check"], {
      input: patch.patch,
      stdio: ["pipe", "ignore", "pipe"],
    });
  }

  console.log(`MCP patch handoff passed for ${path} at ${patch.commit}.`);
} finally {
  await client.close();
}
