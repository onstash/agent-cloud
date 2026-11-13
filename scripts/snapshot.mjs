#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE = "/Users/santoshvenkatraman/Personal/Coding/prompt-shelf";

const LIMIT = 2 * 1024 * 1024;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: LIMIT * 4, ...options });
}

export function validPath(path) {
  const parts = path.split("/");

  return (
    path.length > 0 &&
    path.length <= 512 &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) &&
        !/(?:^|[._-])(env|secret|secrets|token|tokens|credential|credentials|key|keys|pem|p12|pfx)(?:$|[._-])/i.test(
          part,
        ),
    )
  );
}

export function hasLikelySecret(content) {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}|(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_+/-]{16,}/i.test(
    content,
  );
}

export function snapshot(repo, paths, reviewedCommit, { allowHeadChange = false } = {}) {
  if (!paths.length || new Set(paths).size !== paths.length || paths.some((p) => !validPath(p))) {
    throw new Error("Provide unique, relative file paths without dotfiles or sensitive names");
  }

  const head = run("git", ["-C", repo, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const commit = reviewedCommit ?? head;

  if (
    !/^[0-9a-f]{40,64}$/.test(commit) ||
    (!allowHeadChange && reviewedCommit && reviewedCommit !== head)
  ) {
    throw new Error("HEAD does not match the reviewed commit");
  }

  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new Error("Reviewed commit is unavailable");
  }

  let total = 0;
  const files = [];

  for (const path of paths) {
    const record = run("git", [
      "-C",
      repo,
      "ls-tree",
      "-z",
      "--full-tree",
      commit,
      "--",
      `:(literal)${path}`,
    ]);

    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/.exec(record);

    if (!match || match[3] !== path) throw new Error(`Not a committed regular file: ${path}`);
    const size = Number(run("git", ["-C", repo, "cat-file", "-s", match[2]]).trim());

    if (!Number.isSafeInteger(size) || size < 0 || (total += size) > LIMIT)
      throw new Error("Snapshot exceeds 2 MiB");

    const data = execFileSync("git", ["-C", repo, "cat-file", "blob", match[2]], {
      maxBuffer: LIMIT + 1,
    });

    if (data.length !== size) throw new Error(`Invalid blob size: ${path}`);
    // This filter is only a backstop. The operator must review every selected blob.
    const content = data.toString("utf8");

    if (hasLikelySecret(content)) {
      throw new Error(`Possible secret in committed file: ${path}`);
    }

    files.push({ path, data: data.toString("base64"), executable: match[1] === "100755" });
  }

  return { commit, files };
}

export const receiver = `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (fs.realpathSync('/workspace') !== '/workspace') throw Error('Invalid workspace');
const root = '/workspace/snapshot'; fs.mkdirSync(root, {mode: 0o700});
try {
  for (const file of input.files) {
    const parts = file.path.split('/');
    if (!parts.every(p => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p))) throw Error('Invalid path');
    let dir = root;
    for (const part of parts.slice(0, -1)) { dir = path.join(dir, part); try { fs.mkdirSync(dir, {mode: 0o700}); } catch(e) { if (e.code !== 'EEXIST' || !fs.lstatSync(dir).isDirectory()) throw e; } }
    fs.writeFileSync(path.join(dir, parts.at(-1)), Buffer.from(file.data, 'base64'), {flag:'wx', mode: file.executable ? 0o755 : 0o644});
  }
} catch (e) { fs.rmSync(root, {recursive:true, force:true}); throw e; }
`;

export function verifyTarget(id, requireNoNetwork = false) {
  const inspected = JSON.parse(run("docker", ["inspect", id]));
  const container = inspected[0];

  if (
    inspected.length !== 1 ||
    container.Id !== id ||
    !container.State.Running ||
    !/^\/workerd-agent-cloud(?:-[a-z0-9-]+)?-Workspace-[a-f0-9]+$/.test(container.Name) ||
    !/^docker\.io\/library\/node:24\.20\.0-trixie-slim@sha256:[a-f0-9]{64}$/.test(
      container.Config.Image,
    ) ||
    container.Mounts.length !== 0 ||
    (requireNoNetwork &&
      (container.HostConfig.NetworkMode !== "none" ||
        !container.NetworkSettings?.Networks ||
        Object.keys(container.NetworkSettings.Networks).length !== 1 ||
        !("none" in container.NetworkSettings.Networks)))
  )
    throw new Error(
      "Target must be the full ID of a running local agent-cloud workspace with no mounts (and network mode none when required)",
    );
}

function main() {
  const [id, reviewedCommit, ...paths] = process.argv.slice(2);

  if (!id || !/^[0-9a-f]{64}$/.test(id) || !/^[0-9a-f]{40,64}$/.test(reviewedCommit ?? "")) {
    throw new Error(
      "Usage: node scripts/snapshot.mjs <full-container-id> <reviewed-commit-id> <reviewed-file>...",
    );
  }

  const data = snapshot(SOURCE, paths, reviewedCommit);
  verifyTarget(id);

  const result = spawnSync("docker", ["exec", "-i", id, "node", "-e", receiver], {
    input: JSON.stringify(data),
    encoding: "utf8",
    maxBuffer: LIMIT * 2,
  });

  if (result.error || result.status !== 0)
    throw new Error(`Copy failed: ${result.error?.message ?? result.stderr}`);
  console.log(
    `Copied ${data.files.length} committed files from ${data.commit} to /workspace/snapshot in ${id}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
