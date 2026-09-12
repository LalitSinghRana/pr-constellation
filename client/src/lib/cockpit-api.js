import { readJson } from "../hooks/use-query.js";

export async function probeAnalysisAgent({ signal } = {}) {
  const response = await fetch("/api/analysis-agent/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "AI agent probe failed.");
  const agent = body.agent ?? {};
  return {
    accessible: agent.accessible === true,
    message: agent.message || "",
  };
}

export async function fetchAnalysisModels({ signal } = {}) {
  const response = await fetch("/api/analysis-models", { signal });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload?.providers?.length ? payload : null;
}

export async function fetchAnalysisDashboard({ signal } = {}) {
  const response = await fetch("/api/analyses", { signal });
  return readJson(response);
}

export async function fetchInbox({ view = "active", offset, signal } = {}) {
  const params = new URLSearchParams({ view });
  if (offset != null) params.set("offset", String(offset));
  const response = await fetch(`/api/inbox?${params}`, { signal });
  return readJson(response);
}

export async function cancelAnalysisRun({ slug, runId, signal } = {}) {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", headers: { "Content-Type": "application/json" }, signal },
  );
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Analysis could not be canceled.");
  }
}
