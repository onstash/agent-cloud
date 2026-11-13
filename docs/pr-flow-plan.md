# Later milestone: README update through a pull request

## Status

This is a later milestone. `DESIGN.md` sets the first experiment.
The first experiment uses a public fixture, no GitHub credentials, and no push or pull request.
Start this plan only after the fixture experiment passes its completion checks.

## Goal

A client asks the server to update `README.md` in a user-selected public repository.
The server returns a patch. A person approves the exact patch and destination.
Then the server pushes a branch and opens a pull request.

## Happy path

1. The client calls `search` and gets the capability list.
2. `clone_repo` creates a workspace. It shallow-clones the repository at a pinned commit.
   It returns a workspace ID and the commit SHA.
3. `apply_patch` applies the change. It returns a short diff summary.
4. `lint` and `format_check` run in the workspace. Both pass.
5. `open_pr` does not push. It returns `pending_approval`, the exact diff, and an action hash.
6. A person approves the action hash.
7. The server pushes a new branch with a credential for that step only. It opens the pull request and returns the URL.
8. The workspace is destroyed. The audit log records each call.

## Edge cases

| Case | Behavior |
|---|---|
| `README.md` does not exist | Reject. Creating files needs an explicit flag. |
| Default branch is not `main` | Read the default branch from the repository. Do not hardcode it. |
| Repository is large or uses LFS | Use a shallow clone with a size limit. Fail with a clear message. |
| Patch does not apply | Fail. Do not merge automatically. Ask the client to make a new patch. |
| Patch touches a blocked path | Reject the whole patch. Blocked paths include workflow files and secret files. |
| Patch adds a binary file | Reject. |
| Patch is empty | Do nothing. Do not open a pull request. |
| Branch name exists | Add the run ID to the name. |
| Same request is sent twice | Use the run ID to prevent a second pull request. |
| Action changes after approval | Reject. The hash no longer matches. |
| Nobody approves | Expire after the approval limit. Destroy the workspace. Open no pull request. |
| Two runs push to one repository | Lock the repository during the push. |
| `README.md` uses CRLF or non-ASCII text | Keep the original line endings and encoding. |

## Errors

Sort each error into one group:

- **Retry:** network failure, GitHub 5xx response, rate limit. Retry up to 3 times with backoff.
- **Return to the model:** authorization denied, repository not found, patch conflict, policy rejection. Return a short reason. Do not retry.
- **Fail the run:** internal server or workspace failure. Log the details. Return a generic error to the client.

Remove secrets from every error before it goes to the model. Limit the error length.

## Timeouts

Keep one timeout config in the code. Each platform adapter enforces it.
The values below are starting points. Measure real times, then set limits with headroom.

| Limit | Starting value | On timeout |
|---|---|---|
| Clone | 60 s | Stop the workspace. Mark the run `timed_out`. |
| Lint or format | 120 s | Same |
| Whole run | 15 min | Same |
| Approval wait | 24 h | Expire the request |
| Idle workspace | 5 min without calls | Destroy the workspace |
| Calls per run | 50 | Stop and return a summary |

On any timeout, release credentials and write a log entry.

## Security checks

These checks must pass before release.

- **Injected instruction:** a README asks the agent to print a token. The output must not contain the token.
- **Unknown capability:** an unknown capability is rejected and logged.
- **Blocked destination:** a connection to an unlisted host fails and is logged.
- **Credential lifetime:** after the push step, the token is gone from the workspace.
- **Log redaction:** tokens never appear in logs. A failure here blocks release.
- **Untrusted memory:** memory written from repository files or web pages is marked untrusted.

## Cost and audit

- A repeated helper call with the same inputs returns the cached result.
- If the audit log cannot be written, the server refuses writes. No push happens without a log entry.

## Open decisions

- Approval wait: 24 hours, or shorter?
- Calls per run: 50?
- Allow creating new files in the first release?
- Allowed destinations: GitHub only, or GitHub plus the package registry?
