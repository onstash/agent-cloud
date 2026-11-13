import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { hasLikelySecret, snapshot, validPath } from "./snapshot.mjs";

const maxFileBytes = 2 * 1024 * 1024;

const maxPatchBytes = 64 * 1024;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const inputSchema = z.object({
  repository: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  paths: z.array(z.string()).min(1).max(128),
  files: z.array(z.object({ path: z.string(), data: z.string() })),
});

export function createPatch(input) {
  const parsed = inputSchema.safeParse(input);

  if (!parsed.success) throw new Error("Invalid patch input");

  const { repository, commit, paths, files } = parsed.data;

  if (new Set(paths).size !== paths.length || paths.some((path) => !validPath(path))) {
    throw new Error("Invalid configured patch paths");
  }

  if (files.length !== paths.length || files.some((file, index) => file.path !== paths[index])) {
    throw new Error("Workspace files do not match the configured patch paths");
  }

  let baseline;

  try {
    baseline = snapshot(repository, paths, commit, { allowHeadChange: true });
  } catch {
    throw new Error("Pinned source baseline is unavailable or invalid");
  }

  const directory = mkdtempSync(join(tmpdir(), "agent-cloud-patch-"));
  let patch = "";
  const changedFiles = [];
  let totalBytes = 0;

  try {
    for (const [index, path] of paths.entries()) {
      const original = Buffer.from(baseline.files[index].data, "base64");
      const current = Buffer.from(files[index].data, "base64");

      if (current.toString("base64") !== files[index].data) {
        throw new Error(`Invalid workspace file encoding: ${path}`);
      }

      if (original.includes(0) || current.includes(0))
        throw new Error(`Binary file is not supported: ${path}`);

      let currentText;

      try {
        textDecoder.decode(original);
        currentText = textDecoder.decode(current);
      } catch {
        throw new Error(`File is not valid UTF-8: ${path}`);
      }

      if (hasLikelySecret(currentText))
        throw new Error(`Possible secret in workspace file: ${path}`);

      totalBytes += current.length;

      if (totalBytes > maxFileBytes) throw new Error("Workspace files exceed 2 MiB");

      const originalPath = join(directory, `original-${index}`);
      const currentPath = join(directory, `current-${index}`);
      writeFileSync(originalPath, original);
      writeFileSync(currentPath, current);

      const result = spawnSync(
        "diff",
        ["-u", "-L", `a/${path}`, "-L", `b/${path}`, originalPath, currentPath],
        { encoding: "utf8", maxBuffer: maxPatchBytes * 4 },
      );

      if (result.error) throw new Error("Could not create patch");

      if (result.status > 1 || result.status === null)
        throw new Error("Could not compare workspace file");

      if (result.status === 1) {
        const nextSize = Buffer.byteLength(patch) + Buffer.byteLength(result.stdout);

        if (nextSize > maxPatchBytes) throw new Error("Patch exceeds 64 KiB");

        patch += result.stdout;
        changedFiles.push(path);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  return { commit: baseline.commit, changedFiles, patch };
}
