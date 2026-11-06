# Cloud coding experiment: design for review

## Purpose

Build a small cloud coding system to learn its boundaries through use.
Keep the project open source and suitable for self-deployment.
Use Cloudflare infrastructure and an existing agent for the first experiment.

## First result

Codex fixes an intentional TypeScript bug in a small public fixture.
It uses an MCP server to work in a disposable cloud workspace.
The result includes a patch, the test output, and the test exit status.
The experiment also checks that the workspace cannot reach an unauthorized destination.

The fixture is controlled by this project. It needs no GitHub token.
Start with a repeatable fixture. A user-selected public repository is the next milestone.

## Approaches

1. **Cloudflare Code Mode and Sandbox.** Use Code Mode for MCP discovery and execution. Use a separate Linux sandbox for workspace commands. This is the preferred experiment because it tests the proposed boundaries directly.
2. **Direct MCP tools and Sandbox.** Expose workspace operations as separate MCP tools. This is simpler for a small API, but does not test the two-tool interface.
3. **A custom agent harness.** Run the agent loop inside the project. This gives more control, but adds model and session concerns before the workspace works.

The first approach is the working choice from our discussion. Its fit remains an experiment.
If Code Mode cannot support the required operations, record the cause and use the smallest workable alternative.

## Boundaries

```text
Codex
  -> MCP server: search and execute
     -> workspace operations and access policy
        -> disposable Linux sandbox: fixture, edits, tests, patch
```

The MCP server uses Cloudflare Code Mode for `search` and `execute` if its API fits.
Code Mode runs agent-authored JavaScript in an isolated Worker.
The Linux sandbox runs workspace commands. These are separate execution environments.
The host controls which workspace operations Code Mode can call.

One task uses one workspace. The workspace has a bounded lifetime and resource limits.
The first workspace holds a single fixture and receives no secrets.
The server must authenticate its client before it exposes command execution.
The design of that authentication is an implementation decision.

## Network and dependencies

The task workspace denies outbound network access by default.
The first fixture must run its relevant test without network access during agent execution.
The experiment checks a denied connection from inside the workspace.
One failed connection alone does not prove that every network path is blocked.

Later, dependency installation may use a separate setup phase or sandbox.
The implementation must check that the chosen Cloudflare network controls support that separation.
An allowlist alone does not prevent data leakage. Package installation can also run scripts.

## Task lifecycle and results

The server reports command output and exit status within bounded limits.
The first experiment aims to retain command status across a client disconnect.
The implementation must report any gap between that goal and the behavior it can demonstrate.
An interrupted command is reported as interrupted. The server does not replay it automatically.
The agent reports what it tested and what it could not test.

The patch is the first deliverable. The experiment does not push changes or create a pull request.

## Security assumptions

Treat repository content, dependency scripts, agent output, and sandbox commands as untrusted.
Keep credentials out of agent-visible responses and sandbox processes in this experiment.
The server must enforce access controls. Tool descriptions alone do not enforce them.
The experiment must not claim production security from a single successful test.

## Later work

- Add user-selected public repositories, then private repositories with scoped credentials.
- Add restricted dependency setup and check network transitions between phases.
- Add branch or pull request creation after user approval of the exact patch and destination.
- Explore a private catalog for reusable capabilities. Require user approval before trusted reuse.
- Study Pi Durable for task state, recovery, and replay rules. It does not persist the workspace by itself.
- Add other MCP clients after the Codex path works.

## Questions for the experiment

- Can Code Mode expose the workspace operations through its existing OpenAPI integration?
- Which client authentication method works for a self-deployed Codex connection?
- Can the sandbox deny outbound traffic and preserve the test workspace as required?
- Can command status survive a client disconnect within the chosen lifetime limits?
- What Cloudflare account, billing, and local development requirements apply at deployment time?

## Completion checks

1. Codex discovers and calls the intended MCP tools.
2. The fixture test fails before the fix and passes after the fix.
3. The returned patch contains the intended change.
4. The returned test output and exit status match the command result.
5. A connection to a selected unauthorized destination fails inside the task workspace.
6. The experiment records which lifecycle and network properties it could not establish.

## References

- [Cloudflare Code Mode MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/)
- [Cloudflare Sandbox network access](https://developers.cloudflare.com/sandbox/network/)
- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
- [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
