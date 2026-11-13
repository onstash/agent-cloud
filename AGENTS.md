# Agent instructions

Read `DESIGN.md` before you change the experiment.
Read `docs/platform-plan.md` for the planned milestones.

## Documentation

Write new and changed documentation in Simplified Technical English.
Use short sentences and active voice.

## Secrets

Keep local secrets in `.dev.vars`. Git ignores this file.
Do not put tokens in source files, documentation, or chat.

## Verification

Run `pnpm verify` before you commit.
The command checks the format, runs the linter, checks the types, and runs the tests.
The integration test needs Docker.
