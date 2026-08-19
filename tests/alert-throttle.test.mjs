import test from "node:test";
import assert from "node:assert/strict";
import { createAlertThrottle } from "../src/alert-throttle.ts";

const setup = () => {
  let clock = 0;
  const throttle = createAlertThrottle({
    cooldownMs: 60_000,
    maxCooldownMs: 600_000,
    now: () => clock,
  });
  return { throttle, tick: (ms) => { clock += ms; }, at: () => clock };
};

test("first alert for a key is always sent", () => {
  const { throttle } = setup();
  assert.equal(throttle.allow("needs_human:t1", "blocked"), true);
});

test("the cooldown is a floor that differently-worded alerts cannot jump", () => {
  const { throttle, tick } = setup();
  assert.equal(throttle.allow("needs_human:t1", "blocked"), true);
  tick(1_000);
  // The spam amplifier this guards against: rewording must not buy a send.
  assert.equal(throttle.allow("needs_human:t1", "blocked again"), false);
  assert.equal(throttle.allow("needs_human:t1", "something else entirely"), false);
});

test("a repeating condition backs off instead of arriving every cooldown", () => {
  const { throttle, tick } = setup();
  assert.equal(throttle.allow("needs_human:t1", "unknown planning provider"), true);

  // 60s later the same text is due again.
  tick(60_000);
  assert.equal(throttle.allow("needs_human:t1", "unknown planning provider"), true);

  // Now the wait has doubled: 60s is no longer enough.
  tick(60_000);
  assert.equal(throttle.allow("needs_human:t1", "unknown planning provider"), false);
  tick(60_000);
  assert.equal(throttle.allow("needs_human:t1", "unknown planning provider"), true);
});

test("backoff is capped so a permanent condition still checks in", () => {
  const { throttle, tick } = setup();
  throttle.allow("needs_human:t1", "stuck");
  // Drive the repeat count well past where doubling would exceed the ceiling.
  for (let i = 0; i < 20; i += 1) {
    tick(600_000);
    throttle.allow("needs_human:t1", "stuck");
  }
  tick(600_000);
  assert.equal(throttle.allow("needs_human:t1", "stuck"), true, "capped at maxCooldownMs");
});

test("a counter in the detail string does not read as a new condition", () => {
  const { throttle, tick } = setup();
  assert.equal(throttle.allow("agent_stalled:t1", "no heartbeat for 300s"), true);
  tick(60_000);
  // Digit-normalised, so this is the same condition and the backoff applies.
  assert.equal(throttle.allow("agent_stalled:t1", "no heartbeat for 360s"), true);
  tick(60_000);
  assert.equal(throttle.allow("agent_stalled:t1", "no heartbeat for 420s"), false);
});

test("genuinely new text resets the backoff once the floor has passed", () => {
  const { throttle, tick } = setup();
  throttle.allow("needs_human:t1", "unknown planning provider");
  tick(60_000);
  throttle.allow("needs_human:t1", "unknown planning provider");
  tick(60_000);
  // Still inside the doubled wait for the old text...
  assert.equal(throttle.allow("needs_human:t1", "unknown planning provider"), false);
  // ...but a different condition is news, and the floor has elapsed.
  assert.equal(throttle.allow("needs_human:t1", "merge conflict in api/src"), true);
});

test("keys are independent", () => {
  const { throttle } = setup();
  assert.equal(throttle.allow("needs_human:t1", "blocked"), true);
  assert.equal(throttle.allow("needs_human:t2", "blocked"), true);
  assert.equal(throttle.allow("telegram:needs_human:t1", "blocked"), true);
});

test("the ledger does not grow without bound", () => {
  let clock = 0;
  const throttle = createAlertThrottle({
    cooldownMs: 1_000,
    maxCooldownMs: 10_000,
    maxEntries: 10,
    now: () => clock,
  });
  for (let i = 0; i < 200; i += 1) {
    throttle.allow(`needs_human:t${i}`, "blocked");
    clock += 60_000;
  }
  assert.ok(throttle.size() <= 20, `expected pruning, got ${throttle.size()}`);
});
