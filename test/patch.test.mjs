import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPatch } from "../scripts/patch.mjs";

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), "cloud-patch-test-"));
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "src", "file.ts"), "export const value = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "fixture");

  return { repository, commit: git(repository, "rev-parse", "HEAD") };
}

function workspaceFile(data) {
  return { path: "src/file.ts", data: Buffer.from(data).toString("base64") };
}

test("creates a patch from the pinned commit without changing the source checkout", () => {
  const { repository, commit } = fixture();

  try {
    const input = {
      repository,
      commit,
      paths: ["src/file.ts"],
      files: [workspaceFile("export const value = 2;\n")],
    };

    const first = createPatch(input);

    const applicability = spawnSync("git", ["-C", repository, "apply", "--check"], {
      input: first.patch,
      encoding: "utf8",
    });

    assert.equal(applicability.status, 0, applicability.stderr);

    writeFileSync(join(repository, "src", "file.ts"), "export const value = 3;\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "later change");

    const result = createPatch(input);

    assert.equal(result.commit, commit);
    assert.deepEqual(result.changedFiles, ["src/file.ts"]);
    assert.equal(result.patch, first.patch);
    assert.match(result.patch, /^--- a\/src\/file\.ts\n\+\+\+ b\/src\/file\.ts\n/m);
    assert.match(result.patch, /-export const value = 1;/);
    assert.match(result.patch, /\+export const value = 2;/);
    assert.equal(
      readFileSync(join(repository, "src", "file.ts"), "utf8"),
      "export const value = 3;\n",
    );
    assert.equal(git(repository, "status", "--porcelain"), "");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("returns an empty patch when selected files are unchanged", () => {
  const { repository, commit } = fixture();

  try {
    const result = createPatch({
      repository,
      commit,
      paths: ["src/file.ts"],
      files: [workspaceFile("export const value = 1;\n")],
    });

    assert.equal(result.patch, "");
    assert.deepEqual(result.changedFiles, []);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("creates one applicable patch for multiple selected files", () => {
  const { repository } = fixture();

  try {
    writeFileSync(join(repository, "src", "other.ts"), "export const other = 10;\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add second file");
    const commit = git(repository, "rev-parse", "HEAD");

    const result = createPatch({
      repository,
      commit,
      paths: ["src/file.ts", "src/other.ts"],
      files: [
        workspaceFile("export const value = 2;\n"),
        {
          path: "src/other.ts",
          data: Buffer.from("export const other = 20;\n").toString("base64"),
        },
      ],
    });

    const applicability = spawnSync("git", ["-C", repository, "apply", "--check"], {
      input: result.patch,
      encoding: "utf8",
    });

    assert.equal(applicability.status, 0, applicability.stderr);
    assert.deepEqual(result.changedFiles, ["src/file.ts", "src/other.ts"]);
    assert.match(result.patch, /--- a\/src\/file\.ts/);
    assert.match(result.patch, /--- a\/src\/other\.ts/);
    assert.equal(git(repository, "status", "--porcelain"), "");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("rejects unsafe paths, changed baselines, binary files and oversized patches", () => {
  const { repository, commit } = fixture();

  try {
    const input = {
      repository,
      commit,
      paths: ["src/file.ts"],
      files: [workspaceFile("export const value = 2;\n")],
    };

    assert.throws(() => createPatch({ ...input, paths: ["../outside"] }), /Invalid configured/);
    assert.throws(
      () => createPatch({ ...input, commit: "0".repeat(40) }),
      /Pinned source baseline/,
    );
    assert.throws(
      () => createPatch({ ...input, files: [workspaceFile("\0binary")] }),
      /Binary file/,
    );
    assert.throws(
      () => createPatch({ ...input, files: [workspaceFile(Buffer.from([255]))] }),
      /UTF-8/,
    );
    assert.throws(
      () =>
        createPatch({
          ...input,
          files: [workspaceFile('export const apiKey = "abcdefghijklmnop";')],
        }),
      /Possible secret/,
    );
    assert.throws(
      () => createPatch({ ...input, files: [workspaceFile(`${"x".repeat(70 * 1024)}\n`)] }),
      /Patch exceeds 64 KiB/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
