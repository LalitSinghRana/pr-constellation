import assert from "node:assert/strict";
import test from "node:test";
import { SIGNAL_WEIGHTS } from "../../shared/queue-policy.js";
import { SCORING_SIGNAL_BARS, scoreBarLayout } from "../src/lib/scoring.js";

test("score bars grow from the midpoint in proportion to the max absolute score", () => {
  assert.deepEqual(scoreBarLayout(10, 10), {
    negative: false,
    offsetPercent: 50,
    widthPercent: 50,
  });
  assert.deepEqual(scoreBarLayout(-10, 10), {
    negative: true,
    offsetPercent: 0,
    widthPercent: 50,
  });
  assert.deepEqual(scoreBarLayout(5, 10), {
    negative: false,
    offsetPercent: 50,
    widthPercent: 25,
  });
  assert.deepEqual(scoreBarLayout(-4, 10), {
    negative: true,
    offsetPercent: 30,
    widthPercent: 20,
  });
  assert.deepEqual(scoreBarLayout(0, 10), {
    negative: false,
    offsetPercent: 50,
    widthPercent: 0,
  });
});

test("scoring charts list every signal weight in descending score order", () => {
  assert.equal(SCORING_SIGNAL_BARS.length, Object.keys(SIGNAL_WEIGHTS).length);
  const scores = SCORING_SIGNAL_BARS.map((item) => item.score);
  assert.deepEqual(
    scores,
    [...scores].sort((left, right) => right - left),
  );
  assert.equal(
    SCORING_SIGNAL_BARS.find((item) => item.id === "teammate-pr")?.score,
    SIGNAL_WEIGHTS["teammate-pr"],
  );
});
