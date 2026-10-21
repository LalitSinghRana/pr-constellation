import assert from "node:assert/strict";
import test from "node:test";
import { probeAnalysisAgent } from "../analysis/analysis-agent-probe.js";

test("analysis agent probe reports whether codex exec works", async () => {
  const status = await probeAnalysisAgent({ provider: "codex", model: "gpt-5.6-sol" });
  assert.equal(typeof status.accessible, "boolean");
  assert.equal(typeof status.available, "boolean");
  assert.equal(status.provider, "codex");
  assert.equal(status.model, "gpt-5.6-sol");
  assert.ok(status.message);
});

test("analysis agent probe uses settings defaults when given a settings object", async () => {
  const status = await probeAnalysisAgent({
    defaultAnalysisProvider: "codex",
    defaultAnalysisModel: "gpt-5.6-sol",
    defaultAnalysisReasoningEffort: "medium",
  });
  assert.equal(status.provider, "codex");
  assert.equal(status.model, "gpt-5.6-sol");
});
