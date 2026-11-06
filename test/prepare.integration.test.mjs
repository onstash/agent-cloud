import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// This opt-in test needs a local setup image and the exact managed Node image digest.
test(
  "prepares a cached dependency in a networkless execution container",
  { skip: !process.env.CLOUD_CODING_TEST_IMAGE || !process.env.CLOUD_CODING_NODE_IMAGE },
  () => {
    const root = mkdtempSync(join(tmpdir(), "cloud-prepare-"));
    const repo = join(root, "repo");
    const store = join(root, "store");

    const run = (cmd, args, options = {}) =>
      execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();

    let container;

    try {
      mkdirSync(repo);
      mkdirSync(store);
      writeFileSync(
        join(repo, "package.json"),
        '{"name":"offline-fixture","version":"1.0.0","private":true}\n',
      );
      run("docker", [
        "run",
        "--rm",
        "--mount",
        `type=bind,src=${repo},dst=/project`,
        "--mount",
        `type=bind,src=${store},dst=/store`,
        process.env.CLOUD_CODING_TEST_IMAGE,
        "pnpm",
        "--dir",
        "/project",
        "--store-dir",
        "/store",
        "add",
        "is-number@7.0.0",
        "--ignore-scripts",
      ]);
      run("git", ["-C", repo, "init", "-q"]);
      run("git", ["-C", repo, "add", "package.json", "pnpm-lock.yaml"]);
      run("git", [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ]);
      const commit = run("git", ["-C", repo, "rev-parse", "HEAD"]);
      const name = `workerd-cloud-coding-Workspace-${process.pid.toString(16)}`;
      container = run("docker", [
        "run",
        "-d",
        "--network",
        "none",
        "--name",
        name,
        "--entrypoint",
        "sleep",
        process.env.CLOUD_CODING_NODE_IMAGE,
        "infinity",
      ]);
      run("docker", ["exec", container, "mkdir", "/workspace"]);
      run("node", [
        "agents/cloud-coding/scripts/prepare.mjs",
        repo,
        container,
        commit,
        process.env.CLOUD_CODING_TEST_IMAGE,
        join(store, "v10"),
        "package.json",
        "pnpm-lock.yaml",
      ]);
      run("docker", [
        "exec",
        "-w",
        "/workspace/snapshot",
        container,
        "node",
        "-e",
        "if (!require('is-number')(42)) process.exit(1)",
      ]);
      const config = JSON.parse(run("docker", ["inspect", container]))[0];
      assert.equal(config.HostConfig.NetworkMode, "none");
      assert.equal(config.Mounts.length, 0);
      assert.throws(() =>
        run("docker", ["exec", container, "test", "-e", "/workspace/snapshot/.git"]),
      );
      assert.throws(() =>
        run(
          "node",
          [
            "agents/cloud-coding/scripts/prepare.mjs",
            repo,
            container,
            commit,
            process.env.CLOUD_CODING_TEST_IMAGE,
            store,
            "package.json",
            "pnpm-lock.yaml",
          ],
          { stdio: "pipe" },
        ),
      );
    } finally {
      if (container) run("docker", ["rm", "-f", container]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
