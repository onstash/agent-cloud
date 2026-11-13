# Platform plan: a Cloudflare home for agents

## Status

This is a proposal. `DESIGN.md` still describes the current experiment.
Update `MISSION.md` and `DESIGN.md` when work on milestone 2 starts.

## Goal

Give any MCP client a safe place to do work.
The agent calls `search` and `execute`. Deterministic code does the rest.
The agent never sees a secret. The workspace never gets a secret or network access.
A person approves each write.

## Parts

| Part | Job | Cloudflare pieces | State |
|---|---|---|---|
| Gateway | Authenticate the client. Serve `search` and `execute`. | Worker, `agents/mcp` | Built, local only |
| Script sandbox | Run the agent's script. Return only its result. | Code Mode, Worker Loader | Built, local only |
| Workspace | Hold the repository. Run commands and tests. Return a patch. | Container, Durable Object | Built in Docker |
| Packages | Named, versioned helpers. | Worker Loader, D1, R2 | Not built |
| Broker | Hold secrets and approvals. Make outbound calls. | Separate Worker, D1, Secrets Store | Not built |
| Storage | Memory, package state, audit log. | D1, R2 | Not built |

The system has two deployments: the gateway Worker and the broker Worker.
The gateway calls the broker through a service binding.

## Milestones

Do the milestones in order. Each milestone has one check that proves it.

### M0. Local fixture experiment (done)

Merged in pull request 38.

- [x] MCP server with `search` and `execute`
- [x] Disposable workspace in Docker with no network
- [x] Patch output and test status
- [x] Local smoke tests

### M1. Deploy and test isolation

Goal: the current server runs on Cloudflare, and its network isolation is tested.

- [ ] Check the account plan and the container charges.
- [ ] Deploy the Worker. Set `MCP_BEARER_TOKEN` as a Worker secret.
- [ ] Run the smoke test against the deployed URL.
- [ ] Test outbound access from the deployed container. Try DNS, HTTPS, and a raw IP address.
- [ ] Record the results and the gaps in `MEMORY.md`.

Done when: the smoke test passes on the deployed server, and each outbound test fails.
If an outbound test succeeds, stop. Change the workspace design before the next milestone.

### M2. One workspace per run, with a real repository

Goal: each run gets its own workspace that holds a user-selected public repository.

- [ ] Create one Durable Object for each run ID. Remove the shared `fixture-task` name.
- [ ] Use a container image that includes Git.
- [ ] Load a public repository at a pinned commit. The gateway fetches it and copies it into the workspace.
- [ ] Return the patch from `git diff`. Include new, deleted, and renamed files.
- [ ] Decide how dependencies are installed. Compare a prebuilt image with a separate setup container.
- [ ] Put the workspace behind a small interface.

Done when: two runs at the same time cannot see each other's files, and a public repository's tests run without network access.

### M3. Packages

Goal: `search` finds named helpers, and `execute` calls them.

- [ ] Define the manifest: exports, input schema, required secrets, and a write flag.
- [ ] Store package source in R2. Store the index in D1.
- [ ] Make `search` read the index and return short call shapes.
- [ ] Load package modules into the script sandbox.
- [ ] Write the first packages: `run_tests`, `get_patch`, `lint`.

Done when: an agent finds `run_tests` through `search` and calls it in one `execute` script.

### M4. Broker, secrets, and audit log

Goal: code can use a secret, and nothing can read it.

- [ ] Deploy the broker as a separate Worker behind a service binding.
- [ ] Store secrets encrypted in D1. Provide no operation that returns a value.
- [ ] Fill `{{secret:name}}` placeholders at the network boundary.
- [ ] Give each secret a host allowlist. An empty list blocks every use.
- [ ] Fill headers only by default.
- [ ] Write an append-only audit log in D1. Refuse an action if the log write fails.
- [ ] Remove secrets from errors and logs.
- [ ] Move the repository fetch from the gateway to the broker.

Done when: an injection test cannot make the agent print a token, and a request to an unlisted host fails.

### M5. Approvals and pull requests

Goal: a person approves the exact write before it happens.

- [ ] Return `pending_approval` with the diff and an action hash for each write.
- [ ] Build an approval page. Only the owner can approve.
- [ ] Reject an action whose hash changed after approval. Expire old requests.
- [ ] Write the `open_pr` package. It pushes a branch and opens a pull request.
- [ ] Cover the cases in `pr-flow-plan.md`.

Done when: a README change becomes a pull request only after approval, and a changed action is rejected.

### M6. Memory

Goal: facts follow the user across agents.

- [ ] Create the memory table: subject, summary, details, tags, source links, and scope.
- [ ] Show one or two relevant memories on `search`.
- [ ] Check for existing memories before each write.
- [ ] Mark memory from repository files and web pages as untrusted.

Done when: a second MCP client reads a memory that the first client saved.

### M7. Identity

Goal: more than one client, then more than one user.

- [ ] Issue one token for each client. Store a hash, a name, a scope, and an expiry in D1.
- [ ] Record the token name in the audit log.
- [ ] Add OAuth sign-in with GitHub.
- [ ] Add a page that lists connected clients and can disconnect one.
- [ ] Add a user ID to every row and every workspace.

Done when: one client is revoked and the others continue to work.
Do the first two tasks before a second client connects.

## Risks

- Deployed containers may not block all outbound traffic. Milestone 1 tests this.
- Dependency installation needs the package registry. The workspace has no network. Milestone 2 decides the method.
- Code Mode is experimental. Its API can change.
- Kody and Executor may add hosted sandboxes. Treat this project as a way to learn the boundaries.

## References

- `DESIGN.md` for the current experiment
- `docs/pr-flow-plan.md` for the pull request cases
- `docs/patch-handoff-design.md` for the local patch route
