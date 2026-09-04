import assert from "node:assert/strict";
import test from "node:test";
import { shouldConsumeWheelEvent } from "../src/review/wheel-event.js";

test("shouldConsumeWheelEvent keeps horizontal wheel on a horizontal scroller", () => {
  const scroller = {
    clientHeight: 80,
    clientWidth: 80,
    scrollHeight: 80,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 200,
  };
  assert.equal(shouldConsumeWheelEvent(scroller, { deltaX: 12, deltaY: 3 }), true);
  assert.equal(shouldConsumeWheelEvent(scroller, { deltaX: 0, deltaY: 12, shiftKey: true }), true);
});

test("shouldConsumeWheelEvent lets horizontal wheel reach the canvas at horizontal edges", () => {
  const rightEdge = {
    clientHeight: 80,
    clientWidth: 80,
    scrollHeight: 80,
    scrollLeft: 120,
    scrollTop: 0,
    scrollWidth: 200,
  };
  assert.equal(shouldConsumeWheelEvent(rightEdge, { deltaX: 10, deltaY: 0 }), false);
  assert.equal(
    shouldConsumeWheelEvent(rightEdge, { deltaX: 0, deltaY: 10, shiftKey: true }),
    false,
  );

  const leftEdge = {
    clientHeight: 80,
    clientWidth: 80,
    scrollHeight: 80,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 200,
  };
  assert.equal(shouldConsumeWheelEvent(leftEdge, { deltaX: -10, deltaY: 0 }), false);
});

test("shouldConsumeWheelEvent keeps vertical wheel on the scroller until it hits an edge", () => {
  const overflow = { clientHeight: 80, scrollHeight: 200, scrollTop: 0 };
  assert.equal(shouldConsumeWheelEvent(overflow, { deltaY: 10 }), true);
  assert.equal(shouldConsumeWheelEvent(overflow, { deltaY: -10 }), false);

  const bottom = { clientHeight: 80, scrollHeight: 200, scrollTop: 120 };
  assert.equal(shouldConsumeWheelEvent(bottom, { deltaY: 10 }), false);
  assert.equal(shouldConsumeWheelEvent(bottom, { deltaY: -10 }), true);

  const middle = { clientHeight: 80, scrollHeight: 200, scrollTop: 40 };
  assert.equal(shouldConsumeWheelEvent(middle, { deltaY: 10 }), true);
  assert.equal(shouldConsumeWheelEvent(middle, { deltaY: -10 }), true);

  const noOverflow = { clientHeight: 80, scrollHeight: 80, scrollTop: 0 };
  assert.equal(shouldConsumeWheelEvent(noOverflow, { deltaY: 10 }), false);
});

test("shouldConsumeWheelEvent ignores missing scrollers", () => {
  assert.equal(shouldConsumeWheelEvent(null, { deltaY: 12 }), false);
});
