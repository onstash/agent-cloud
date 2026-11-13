#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { receiver, snapshot, verifyTarget } from "./snapshot.mjs";

const [source, target, commit, image, store, ...paths] = process.argv.slice(2);

if (
  !source ||
  !/^[a-f0-9]{64}$/.test(target ?? "") ||
  !/^[a-f0-9]{40,64}$/.test(commit ?? "") ||
  !image ||
  !store ||
  !paths.length
) {
  console.error(
    "Usage: node scripts/prepare.mjs <source-repository> <full-container-id> <reviewed-commit-id> <local-setup-image> <pnpm-store-path> <reviewed-file>...",
  );
  process.exit(1);
}

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

let setup;

try {
  const data = snapshot(source, paths, commit);
  verifyTarget(target, true);
  // Never pull an image or give the setup container network access.
  const setupImage = JSON.parse(docker(["image", "inspect", image]))[0];
  const targetInfo = JSON.parse(docker(["inspect", target]))[0];
  const targetImage = JSON.parse(docker(["image", "inspect", targetInfo.Image]))[0];

  if (setupImage.Os !== targetImage.Os || setupImage.Architecture !== targetImage.Architecture) {
    throw new Error("Setup and execution images must use the same OS and architecture");
  }

  const cacheMount = process.env.LOCAL_PNPM_CACHE_PATH
    ? [
        "--mount",
        `type=bind,src=${resolve(process.env.LOCAL_PNPM_CACHE_PATH)},dst=/metadata-cache,readonly`,
      ]
    : [];

  setup = docker([
    "create",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${resolve(store)},dst=/cache,readonly`,
    ...cacheMount,
    "--entrypoint",
    "sleep",
    image,
    "infinity",
  ]).trim();
  docker(["start", setup]);
  docker(["exec", setup, "mkdir", "-p", "/workspace"]);
  docker(["exec", "-i", setup, "node", "-e", receiver], { input: JSON.stringify(data) });
  // The cache is read-only; pnpm may update its copied store metadata.
  docker(
    [
      "exec",
      setup,
      "sh",
      "-ec",
      'store=$(pnpm store path --store-dir /tmp/pnpm-store); mkdir -p "$store"; cp -a /cache/. "$store"/; if [ -d /metadata-cache ]; then mkdir -p /root/.cache/pnpm; cp -a /metadata-cache/. /root/.cache/pnpm/; fi; cd /workspace/snapshot; pnpm install --offline --ignore-scripts --frozen-lockfile --store-dir /tmp/pnpm-store',
    ],
    { stdio: "inherit" },
  );
  docker([
    "exec",
    setup,
    "sh",
    "-ec",
    "find /workspace/snapshot -name .git -prune -exec rm -rf -- {} +",
  ]);
  verifyTarget(target, true);
  docker(["exec", target, "mkdir", "/workspace/snapshot"]);
  let transferred = false;

  try {
    const from = spawn(
      "docker",
      ["exec", setup, "tar", "-C", "/workspace/snapshot", "-cf", "-", "."],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    const to = spawn(
      "docker",
      ["exec", "-i", target, "tar", "-C", "/workspace/snapshot", "-xf", "-"],
      { stdio: ["pipe", "inherit", "inherit"] },
    );

    from.stdout.pipe(to.stdin);

    const status = (child) =>
      new Promise((resolveStatus, reject) => {
        child.on("error", reject);
        child.on("close", resolveStatus);
      });

    to.stdin.on("error", () => {});
    const results = await Promise.all([status(from), status(to)]);

    if (results.some((code) => code !== 0))
      throw new Error(`Transfer failed: ${results.join(", ")}`);
    transferred = true;
  } finally {
    if (!transferred) spawnSync("docker", ["exec", target, "rm", "-rf", "/workspace/snapshot"]);
  }

  console.log(`Prepared ${data.files.length} files from ${data.commit} in /workspace/snapshot`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (setup) spawnSync("docker", ["rm", "-f", setup], { stdio: "ignore" });
}
