import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/sum.js";

test("bulk discount applies to the subtotal over 100", () => {
  assert.equal(total([{ price: 60, qty: 2 }]), 108);
});

test("no discount under the threshold", () => {
  assert.equal(total([{ price: 10, qty: 2 }]), 20);
});
