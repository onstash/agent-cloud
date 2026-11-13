# Patch handoff design

## Intent

Return a reviewable patch to the coding agent from the local offline workspace.
Keep the source repository and the trusted baseline outside the container.

## Decision and approaches

Add a `/patch` operation to the Code Mode API. It remains callable through the
existing MCP `execute` tool, so the top-level MCP surface stays `search` and
`execute`. The Worker calls a fixed `/patch` endpoint on the host broker. The
broker reads baseline blobs from a repository and commit configured at startup,
then reads the configured allowlisted files from the selected offline container.
It compares them on the host and returns a unified patch. The model cannot
choose a host path, repository, commit, or container.

A separate host-side export script would be smaller, but it would make the
operator run a second command after the agent finishes. A baseline copied into
the container would be easy to diff, but task code could change it before
export. The MCP operation keeps the handoff in the agent workflow while the
trusted baseline stays on the host.

## Goals

- Return changes only for files in the startup-configured allowlist and the
  pinned commit.
- Require a running cloud-coding container with no mounts and Docker network
  mode `none`.
- Read the exact commit selected before the task, even if the source branch
  later advances.
- Reject unsafe paths, non-regular files, binary data, invalid UTF-8, and likely
  secrets. Reject patches over 64 KiB.
- Return a complete patch or an error. Never truncate it.
- Never modify the source checkout or apply the patch.

## Non-goals

- Support new, deleted, renamed, permission-only, binary, or unselected files
  in this increment.
- Add GitHub integration, credentials, or deployment support.
- Claim that the local Docker setup is a production security boundary.

## Constraints

- Keep the script, tests, and documentation inside this repository.
- Reuse the snapshot path rules and container checks where practical.
- Use only local Git and Docker operations. Do not use the network.
- The operator must review the patch before applying it.

## Success check

Given a committed file and a matching offline container, request a patch through
MCP that applies to the pinned commit and contains only the selected file
changes. Reject an unsafe container, invalid path, missing file, or patch that
exceeds the size limit. Confirm that export leaves the source checkout
unchanged.
