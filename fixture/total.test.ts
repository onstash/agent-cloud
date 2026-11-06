import assert from "node:assert/strict";
import test from "node:test";
import { totalCents } from "./total.ts";

test("adds prices in cents", () => {
  assert.equal(totalCents([125, 250, 50]), 425);
});

test("returns zero for an empty list", () => {
  assert.equal(totalCents([]), 0);
});
