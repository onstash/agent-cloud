# Cloud coding experiment

This experiment gives an existing agent a disposable Cloudflare workspace.
The MCP server exposes Cloudflare Code Mode `search` and `execute` tools.
The workspace starts with a small TypeScript bug and no credentials.
The container has internet access disabled.

Read [DESIGN.md](DESIGN.md) for the design and later milestones.
This is a learning experiment. It is not a production security boundary.

## Requirements

- Node.js, pnpm, and Docker. Start the Docker daemon before local tests.
- A Cloudflare account with the [Workers Paid plan](https://developers.cloudflare.com/sandbox/) for deployment.
- Codex or another MCP client for interactive use.

Run commands from the repository root. Install dependencies with `pnpm install`.

## Run locally

Start the local server with a test token. Use this token only on your machine.

```sh
pnpm exec wrangler dev --local --port 8799 --var MCP_BEARER_TOKEN:local-test-token-12345
```

In another terminal, run the smoke test:

```sh
MCP_BEARER_TOKEN=local-test-token-12345 node test/local-smoke.mjs
```

The test checks authentication, tool discovery, the fixture fix, and a denied network request.
It also checks the test status and patch. The test deletes its workspace at the end.
One failed network request does not prove that all network access is blocked.
Local Docker isolation is different from the deployed Cloudflare container isolation.

To connect Codex, put the test token in its environment and add the server:

```sh
export CLOUD_CODING_TOKEN=local-test-token-12345
codex mcp add cloud-coding --url http://127.0.0.1:8799/mcp --bearer-token-env-var CLOUD_CODING_TOKEN
```

Start a new Codex session with that environment. Ask it to use the `cloud-coding` MCP tools.
Ask it to fix the fixture, run the tests, and show the patch.
Codex may require approval for MCP tool calls. A session that denies approvals cannot complete this task.

## Deploy later

First check the account plan and Cloudflare container charges.
Use a unique, random bearer token for the deployed server.
Set `MCP_BEARER_TOKEN` as a Worker secret with Wrangler. Do not put it in source files or chat.
Use `wrangler deploy` from this package to deploy after you configure the account.
Use an HTTPS MCP URL and keep the bearer token in the client environment.

## Current limits

- The local bridge has been tested with Codex and a small Prompt Shelf snapshot.
- Cloudflare deployment and deployed network isolation have not yet been tested.
- The server uses one shared workspace for all holders of the token. It is for one trusted user and one task at a time.
- The workspace is disposable. Cleanup or inactivity deletes its files.
- Commands time out and output is capped. The implementation does not fully contain hostile process trees or output-file tampering.
- Command status does not survive a client disconnect. An interrupted command may have changed the workspace.
- The standard server starts with the bundled fixture. The local bridge can use a separately prepared workspace. Neither server clones repositories.
- The fixture server returns a `diff -u` patch. Its managed image does not provide Git.
- Local patch handoff supports modified text files in its configured allowlist. It does not include new, deleted, renamed, or binary files.
- Code Mode is experimental. Its APIs may change.

## Copy a local committed snapshot

This optional host-side command copies selected files from the local
`/Users/santoshvenkatraman/Personal/Coding/prompt-shelf` repository. It reads
blobs from one resolved `HEAD` commit. It does not read working-tree changes,
Git configuration, or credentials. It does not modify the source repository.
The file arguments form the allowlist. Directories, symlinks, dotfiles, sensitive
file names, and paths with traversal are rejected. The total limit is 2 MiB.

Before running it, inspect the exact committed contents of every file. Do not
select files that contain secrets, tokens, private data, or generated credentials.
The script rejects some common secret patterns, but it cannot detect all secrets.
The operator must review the commit and the selected files. For example:

```sh
git -C /Users/santoshvenkatraman/Personal/Coding/prompt-shelf rev-parse HEAD
git -C /Users/santoshvenkatraman/Personal/Coding/prompt-shelf show HEAD:path/to/reviewed-file
```

Start the local server and run a fixture command first to start its container.
Find the full ID of the intended disposable sandbox with `docker ps --no-trunc`.
Check the ID carefully. Then pass that ID and the reviewed paths:

```sh
node scripts/snapshot.mjs <full-container-id> <reviewed-commit-id> path/to/reviewed-file
```

The command accepts the local Node 24 image used by the current Cloudflare
development runtime. It requires a matching workspace name and no Docker mounts.
It uses the exact ID and does not start, stop, or remove containers.
It creates `/workspace/snapshot` once. It fails if that directory already exists.
The directory disappears when the disposable workspace is destroyed. The sandbox
must have Node.js and an existing `/workspace` directory. This route is local
Docker only; it does not work with a deployed Cloudflare container. It does not
prove the selected container belongs to this experiment. Container image names and
the local Docker daemon are not security boundaries. The command does not add a
host path or a snapshot upload operation to MCP. The normal MCP command tool can
read and modify the copied files. Avoid concurrent sandbox commands during the copy.
The command requires the full reviewed commit ID and fails if `HEAD` has changed.
Review files with `git show <reviewed-commit-id>:path/to/file` before the copy.

## Prepare files and dependencies offline

This local workflow creates a separate Docker execution container. The managed
local workspace shares a network namespace with a proxy. The preparation command
rejects it. The local bridge below connects the separate container to MCP.
This workflow does not deploy anything.

Review the exact commit and every selected file as described above. Include the
root manifest, lockfile, workspace configuration, each selected workspace
manifest, and the source files you need. The snapshot rules above also apply
here. They reject dotfiles, symlinks, and snapshots over 2 MiB. Partial
workspaces, local dependencies, native modules, and packages that need install
scripts may not work. The pnpm store must already contain every package for the
selected lockfile and the setup container's platform. This command does not
fetch missing packages or populate the host store.

Prepare a trusted local Linux setup image with Node, tar, and the pnpm version
required by the selected commit. Build it separately before this workflow. For
example, use a reviewed Node image and install the required pnpm version in it.
The setup image must use the same OS and CPU architecture as the execution
image. For example, build a local image with the pnpm version from the reviewed
manifest. Replace `<platform>` and `<pnpm-version>` first. This build uses the
network and must be run separately from the offline preparation step.

```sh
docker build --platform <platform> -t cloud-coding-setup - <<'DOCKERFILE'
FROM node:24
RUN npm install -g pnpm@<pnpm-version>
DOCKERFILE
```

Pass the versioned directory printed by `pnpm store path`, using the same pnpm
version as the setup image. Copying a large store can take time and disk space.
Review the image and dependencies:
`--ignore-scripts` does not make their contents trustworthy. Do not put secrets
in the image or the selected files. The secret filter is only a backstop.

Start a disposable execution container with the exact local runtime image digest
used by this experiment. Replace the digest below with the digest reported by
`docker inspect` for a local cloud-coding workspace. Use a unique name that
matches the example. The container must have no mounts.

```sh
docker run -d --network none --name workerd-cloud-coding-Workspace-abcd \
  --entrypoint sleep docker.io/library/node:24.20.0-trixie-slim@sha256:<digest> infinity
docker exec workerd-cloud-coding-Workspace-abcd mkdir -p /workspace
docker inspect --format '{{.Id}}' workerd-cloud-coding-Workspace-abcd
```

Then use the full container ID, the reviewed commit ID, the local setup image,
the absolute host pnpm store path, and the reviewed file paths:

```sh
node scripts/prepare.mjs /Users/santoshvenkatraman/Personal/Coding/prompt-shelf \
  <full-container-id> <reviewed-commit-id> \
  <local-setup-image> <absolute-pnpm-store-path> \
  package.json pnpm-lock.yaml pnpm-workspace.yaml app/package.json <other-reviewed-files>
docker exec -it <full-container-id> sh
```

The command copies committed blobs into a temporary setup container. That
container has Docker networking disabled. It mounts the host store read-only,
copies it internally, and runs `pnpm install --offline --ignore-scripts
--frozen-lockfile`. It then copies the resulting tree into the execution
container and removes the setup container. It removes `.git` entries before
transfer. It fails if `/workspace/snapshot` already exists. The execution
container receives no source or store mount and uses Docker network mode `none`.
It receives no GitHub token from this workflow. Check the image and files for
credentials yourself. Avoid concurrent commands in either container during
preparation. The Docker daemon, local host, setup image, and operator are trusted.
Docker network mode `none` is not a claim of complete isolation from the host.
The copied dependency tree may contain sensitive data if the store or packages
do. Review those inputs before use. Remove the disposable execution container
when finished:

```sh
docker rm -f <full-container-id>
```

The optional integration test builds a small fixture and populates a temporary
cache over the network. It then tests the offline preparation step. It requires
a setup image with pnpm 10 and the matching managed Node image digest:

```sh
CLOUD_CODING_TEST_IMAGE=<setup-image> CLOUD_CODING_NODE_IMAGE=<node-image-with-digest> \
  node --test test/prepare.integration.test.mjs
```

## Connect the offline container to Codex

The local bridge connects the prepared container to Cloudflare Code Mode. It
uses Docker on the host. The container receives no Docker socket or bridge token.
The bridge accepts one container ID and checks its network and mounts before each
command. This is a local experiment, not a production isolation boundary. It does
not automatically destroy the execution container or persist command status.

The preparation step can also use cached pnpm verification metadata. Set
`LOCAL_PNPM_CACHE_PATH` to the host pnpm cache directory before `prepare.mjs`.
The setup container copies that cache. It is not mounted in the execution
container. Keep secrets out of the cache and review packages before use.
The install remains offline and uses `--ignore-scripts`.

After preparing the workspace, configure the source repository, reviewed commit,
and the same file allowlist you copied into the container. The broker reads the
baseline from that commit. It does not read the working tree.

```sh
export LOCAL_BROKER_SOURCE_REPOSITORY=/path/to/source-repository
export LOCAL_BROKER_SOURCE_COMMIT='<reviewed-commit-id>'
export LOCAL_BROKER_SOURCE_PATHS='["app/src/lib/example.ts","app/src/lib/example.test.ts"]'
```

Set a random bridge token and a separate random MCP token in your shell. Use
values of at least 32 bytes. Do not put them in chat or commit them. Set
`LOCAL_BROKER_CONTAINER_ID` to the full prepared container ID. Start the local
bridge:

```sh
node scripts/local-broker.mjs
```

Create `.dev.vars` with `LOCAL_BROKER_TOKEN` and
`MCP_BEARER_TOKEN`. The cloud-coding `.gitignore` excludes this file. Keep it
private and delete it when finished. Start the local Worker:

```sh
pnpm exec wrangler dev --local --config wrangler.local.jsonc --port 8802
```

Connect a local Codex MCP client to `http://127.0.0.1:8802/mcp` with the MCP
token. The agent can call `search` and `execute`. Commands start in `/`; use
`cd /workspace/snapshot` to reach the prepared files. Stop the bridge and Worker
when finished. Remove the temporary env file and destroy the execution container.

After the agent edits and tests the workspace, it can request a patch through
Code Mode `execute`:

```js
async () => codemode.request({ method: "GET", path: "/patch" });
```

The broker returns a complete unified patch for the configured files, or an
error if it cannot make a complete patch within 64 KiB. It reads only those
files from the container and the pinned Git commit on the host. It does not
apply the patch or write to the source repository. Review the patch before
applying it. The broker checks for common secret patterns, but this scan is not
complete. New, deleted, renamed, permission-only, and binary changes are not
supported.

To test patch retrieval through MCP with a disposable TypeScript fixture, set
`PATCH_SMOKE_PATH` to a selected file in the snapshot and run:

```sh
export PATCH_SMOKE_PATH=src/file.ts
node test/local-patch-mcp-smoke.mjs
```

The smoke test appends a marker comment to that file in the container, requests
the patch through `execute`, and checks that the response includes the marker.
Run it only in a disposable workspace.

For a Prompt Shelf snapshot with `app/src/lib/compile-prompt.ts` and its test,
run this smoke test from the repository root. Set `MCP_BEARER_TOKEN` in the
environment first.

```sh
node test/local-bridge-smoke.mjs
```

It checks MCP authentication, tool discovery, patch retrieval, a project
dependency, and the copied test. It also checks for named credential variables
and the Docker socket, then makes one external network request that must fail.

The execution container holds only the files selected for the snapshot and the
installed dependencies. The setup host and packages must still be trusted. A
single failed external request does not prove that every network path is blocked.
Never deploy `wrangler.local.jsonc`; it is for local development only.
