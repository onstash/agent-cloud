import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshot, validPath } from "../scripts/snapshot.mjs";

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

test("copies only explicitly named regular files from HEAD", () => {
  const repo = mkdtempSync(join(tmpdir(), "cloud-snapshot-test-"));

  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "user.name", "Test");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "file.txt"), "committed\n");
    writeFileSync(join(repo, "danger.txt"), "password = abcdefghijklmnopqrstuvwxyz\n");
    symlinkSync("src/file.txt", join(repo, "link"));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "fixture");
    writeFileSync(join(repo, "src", "file.txt"), "unstaged\n");
    const result = snapshot(repo, ["src/file.txt"]);
    assert.equal(Buffer.from(result.files[0].data, "base64").toString(), "committed\n");
    assert.throws(() => snapshot(repo, ["src/file.txt"], "0".repeat(40)), /reviewed commit/);
    assert.throws(() => snapshot(repo, ["src"]));
    assert.throws(() => snapshot(repo, ["link"]));
    assert.throws(() => snapshot(repo, ["danger.txt"]), /Possible secret/);
    assert.throws(() => snapshot(repo, ["src/file.txt", "src/file.txt"]));

    for (const path of [
      "../file",
      "/file",
      "src/../file",
      ".git/config",
      ".env",
      "api-key.txt",
      "src//file",
    ]) {
      assert.equal(validPath(path), false, path);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
