import assert from "node:assert/strict";
import test from "node:test";
import { probeAnalysisAgent } from "../analysis/analysis-agent-probe.js";

test("analysis agent probe reports whether a real cursor agent --print invocation works", async () => {
  const status = await probeAnalysisAgent({ model: "cursor-grok-4.5" });
  assert.equal(typeof status.accessible, "boolean");
  assert.equal(typeof status.available, "boolean");
  assert.equal(status.provider, "cursor");
  assert.equal(status.model, "cursor-grok-4.5");
  assert.ok(status.message);
});

test("analysis agent probe reports whether codex exec works", async () => {
  const status = await probeAnalysisAgent({ provider: "codex", model: "gpt-5.6-sol" });
  assert.equal(typeof status.accessible, "boolean");
  assert.equal(typeof status.available, "boolean");
  assert.equal(status.provider, "codex");
  assert.equal(status.model, "gpt-5.6-sol");
  assert.ok(status.message);
});

test("analysis agent probe reports whether claude --print works", async () => {
  const status = await probeAnalysisAgent({
    provider: "claude",
    model: "claude-sonnet-4-6",
  });
  assert.equal(typeof status.accessible, "boolean");
  assert.equal(typeof status.available, "boolean");
  assert.equal(status.provider, "claude");
  assert.equal(status.model, "claude-sonnet-4-6");
  assert.ok(status.message);
});
