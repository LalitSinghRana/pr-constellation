import assert from "node:assert/strict";
import test from "node:test";
import { probeAnalysisAgent } from "../analysis/analysis-agent-probe.js";

test("analysis agent probe reports whether a real agent --print invocation works", async () => {
  const status = await probeAnalysisAgent({ model: "grok-4.5" });
  assert.equal(typeof status.accessible, "boolean");
  assert.equal(typeof status.available, "boolean");
  assert.equal(status.provider, "cursor");
  assert.equal(status.model, "grok-4.5");
  assert.ok(status.message);
});
