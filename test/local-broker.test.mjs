import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const id = "a".repeat(64);

const token = "t".repeat(32);

test("local broker authenticates, validates requests and inspects before each fixed Docker exec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-broker-"));
  const state = join(dir, "state");
  const log = join(dir, "log");
  const source = join(dir, "source");
  const sourceFile = join(source, "src", "file.ts");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(sourceFile, "export const value = 1;\n");
  const git = (...args) => spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", source]);
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD").stdout.trim();
  const changed = Buffer.from("export const value = 2;\n").toString("base64");

  const fake = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') {
  const mode = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
  console.log(JSON.stringify([{Id: ${JSON.stringify(id)}, State: {Running: mode !== 'stopped'}, Mounts: mode === 'mount' ? [{}] : [], HostConfig: {NetworkMode: mode === 'network' ? 'host' : 'none'}, NetworkSettings: {Networks: mode === 'attached' ? {none: {}, bridge: {}} : {none: {}}}, Config: {Env: mode === 'token' ? [${JSON.stringify(`SECRET=${token}`)}] : []}}]));
} else if (args[0] === 'exec' && args[1] === '-i') {
  process.stdout.write(JSON.stringify({files:[{path:'src/file.ts',data:${JSON.stringify(changed)}}]}));
} else { process.stdout.write(args.at(-1)); process.exitCode = 7; }
`;

  writeFileSync(join(dir, "docker"), fake, { mode: 0o755 });
  writeFileSync(state, "safe");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));

  const child = spawn(process.execPath, [resolve("agents/cloud-coding/scripts/local-broker.mjs")], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      LOCAL_BROKER_TOKEN: token,
      LOCAL_BROKER_CONTAINER_ID: id,
      LOCAL_BROKER_PORT: String(port),
      LOCAL_BROKER_SOURCE_REPOSITORY: source,
      LOCAL_BROKER_SOURCE_COMMIT: commit,
      LOCAL_BROKER_SOURCE_PATHS: JSON.stringify(["src/file.ts"]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await once(child.stdout, "data");

    const call = (body, authorization = `Bearer ${token}`, path = "/command") =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify(body),
      });

    assert.equal((await call({ command: "true" }, "Bearer wrong")).status, 401);
    assert.equal((await call({ command: "true" }, `Bearer ${token}`, "/other")).status, 404);

    for (const body of [
      { command: "true", path: "/host" },
      { command: "a\0b" },
      { command: "x".repeat(8193) },
    ]) {
      assert.equal((await call(body)).status, 400);
    }

    assert.equal((await call({ command: "x".repeat(17000) })).status, 413);

    for (const mode of ["stopped", "mount", "network", "attached", "token"]) {
      writeFileSync(state, mode);
      assert.equal((await call({ command: "echo test" })).status, 503, mode);
    }

    writeFileSync(state, "safe");
    const response = await call({ command: "echo '$HOME'; exit 7" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.output, "echo '$HOME'; exit 7");
    assert.equal(result.exitCode, 7);
    assert.ok(Number.isFinite(result.durationMs));

    const patchResponse = await fetch(`http://127.0.0.1:${port}/patch`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(patchResponse.status, 200);
    const patch = await patchResponse.json();
    assert.equal(patch.commit, commit);
    assert.deepEqual(patch.changedFiles, ["src/file.ts"]);
    assert.match(patch.patch, /\+export const value = 2;/);
    assert.equal(readFileSync(sourceFile, "utf8"), "export const value = 1;\n");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((args) => args[0] === "inspect").length, 7);
    assert.deepEqual(
      calls.find((args) => args[0] === "exec" && args[1] === id),
      ["exec", id, "timeout", "-k", "1s", "30s", "sh", "-c", "echo '$HOME'; exit 7"],
    );
    assert.deepEqual(calls.at(-1).slice(0, 4), ["exec", "-i", id, "node"]);
  } finally {
    child.kill();
    await once(child, "exit");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup fails closed without credentials or a full container ID", async () => {
  const child = spawn(process.execPath, [resolve("agents/cloud-coding/scripts/local-broker.mjs")], {
    env: { ...process.env, LOCAL_BROKER_TOKEN: "", LOCAL_BROKER_CONTAINER_ID: id },
    stdio: "ignore",
  });

  const [code] = await once(child, "exit");
  assert.equal(code, 1);
});
