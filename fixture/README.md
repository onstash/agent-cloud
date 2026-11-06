# Fix the total

`totalCents` must add the prices in cents and return their total. An empty
list must return zero. Fix the bug in `total.ts` without changing the tests.

Run the tests with Node.js 24 from this directory:

```sh
node --test total.test.ts
```

The tests fail before the fix. Run them again after the fix. They must pass.
Node strips the TypeScript types itself. This task needs no dependencies or
network access.

The workspace has a copy of the original file in `/baseline/total.ts`.
After the fix, run `diff -u /baseline/total.ts /workspace/total.ts`.
The `diff` command returns exit status 1 when it finds a change.
