import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAKE_TEXT, createWake } from '../src/wake.ts';

const setup = (cap?: number) => {
  const snap = { active: true, fingerprint: 'a' };
  const sent: string[] = [];
  let pending: (() => void) | undefined;
  const wake = createWake({
    cap,
    snapshot: () => snap,
    send: (text) => sent.push(text),
    setTimer: (fn) => {
      pending = fn;
      return fn;
    },
    clearTimer: () => {
      pending = undefined;
    },
  });
  const fire = () => {
    const fn = pending;
    pending = undefined;
    fn?.();
  };
  return { snap, sent, wake, fire, armed: () => pending !== undefined };
};

test('arms on settled only when active; busy clears', () => {
  const t = setup();
  t.snap.active = false;
  t.wake.settled();
  assert.equal(t.armed(), false);
  t.snap.active = true;
  t.wake.settled();
  assert.equal(t.armed(), true);
  t.wake.busy();
  assert.equal(t.armed(), false);
});

test('wake sends WAKE_TEXT once per interval and ends when inactive', () => {
  const t = setup();
  t.wake.settled();
  t.fire();
  assert.deepEqual(t.sent, [WAKE_TEXT]);
  assert.equal(t.armed(), false);
  t.snap.active = false;
  t.wake.settled();
  assert.equal(t.armed(), false);
});

test('unchanged fingerprint stops after cap; change resumes', () => {
  const t = setup(2);
  for (let i = 0; i < 2; i += 1) {
    t.wake.settled();
    t.fire();
    t.wake.busy(); // wake-initiated: count kept
  }
  assert.equal(t.sent.length, 2);
  t.wake.settled();
  assert.equal(t.armed(), false);
  t.snap.fingerprint = 'b';
  t.wake.settled();
  assert.equal(t.armed(), true);
  t.fire();
  assert.equal(t.sent.length, 3);
});

test('external busy and userInput reset the count', () => {
  const t = setup(1);
  t.wake.settled();
  t.fire();
  t.wake.busy();
  t.wake.settled();
  assert.equal(t.armed(), false);
  t.wake.userInput();
  t.wake.settled();
  assert.equal(t.armed(), true);
  t.fire();
  assert.equal(t.sent.length, 2);
  // external busy (no wake pending) resets
  t.wake.busy();
  t.wake.busy();
  t.wake.settled();
  assert.equal(t.armed(), true);
});

test('waitForUser suppresses until userInput', () => {
  const t = setup();
  t.wake.settled();
  t.wake.waitForUser();
  assert.equal(t.armed(), false);
  t.wake.settled();
  assert.equal(t.armed(), false);
  t.wake.userInput();
  t.wake.settled();
  assert.equal(t.armed(), true);
});

test('stop clears the timer and prevents wakes', () => {
  const t = setup();
  t.wake.settled();
  t.wake.stop();
  assert.equal(t.armed(), false);
  t.wake.settled();
  assert.equal(t.armed(), false);
  assert.deepEqual(t.sent, []);
});
