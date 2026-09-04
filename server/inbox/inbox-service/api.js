import { settingsAnalysisRunOptions } from "../../../shared/analysis-models.js";
import { probeAnalysisAgent } from "../../analysis/analysis-agent-probe.js";
import { loadAnalysisCatalog } from "../../analysis/analysis-model-catalog.js";
import { host } from "../../runtime-config.js";
import {
  automaticallyQueueNewAnalyses,
  enqueueMissingAnalyses,
  normalizeAnalysisCandidate,
  queueInboxAnalyses,
} from "./analysis-queue.js";
import {
  notificationThreadIdFromRecord,
  syncInboxDoneToGitHub,
  syncInboxReadToGitHub,
} from "./github-write-back.js";
import { secureHeaders, sendJson } from "./http-guards.js";

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

export function createInboxApi({
  addInboxPullRequest,
  getInboxStore,
  inboxFromQueue,
  mutateQueueState,
  readQueueState,
  readSettings,
  resolveGitHubUsername: resolveGitHubUsernameOption,
  saveSettings,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  syncInboxDoneToGitHub: syncDoneToGitHub = syncInboxDoneToGitHub,
  syncInboxReadToGitHub: syncReadToGitHub = syncInboxReadToGitHub,
}) {
  const resolveGitHubUsername =
    resolveGitHubUsernameOption ??
    (async () => {
      const saved = await readSettings();
      return typeof saved.username === "string" ? saved.username : "";
    });
  return async function handleApiRequest(
    request,
    response,
    { dashboardService, eventHub, scheduler },
  ) {
    const url = new URL(request.url, `http://${request.headers.host ?? host}`);

    if (url.pathname === "/api/analyses" && request.method === "GET") {
      try {
        sendJson(response, 200, await dashboardService.snapshot());
      } catch (error) {
        sendJson(response, 502, { error: error.message });
      }
      return true;
    }

    if (url.pathname === "/api/analyses" && request.method === "POST") {
      try {
        const body = await readRequestJson(request);
        const candidate = normalizeAnalysisCandidate(body);
        const settings = await readSettings();
        const run = await dashboardService.enqueue({
          additions: candidate.additions,
          changedFiles: candidate.changedFiles,
          deletions: candidate.deletions,
          inboxScore: candidate.inboxScore,
          ...settingsAnalysisRunOptions(settings),
          prioritize: candidate.prioritize,
          prUrl: candidate.url,
          refresh: true,
          title: candidate.title,
        });
        eventHub.publish("analysis", { runId: run.runId });
        sendJson(response, 202, { run, runs: [run] });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return true;
    }

    if (url.pathname === "/api/analyses/queue" && request.method === "POST") {
      try {
        const body = await readRequestJson(request);
        const settings = await readSettings();
        const runs = Array.isArray(body.pullRequests)
          ? await enqueueMissingAnalyses(
              body.pullRequests.filter((item) => !item?.authored),
              dashboardService,
              settingsAnalysisRunOptions(settings),
            )
          : await queueInboxAnalyses(
              inboxFromQueue(await readQueueState()).items,
              dashboardService,
              settingsAnalysisRunOptions(settings),
            );
        eventHub.publish("analysis", { queued: runs.length });
        sendJson(response, 202, { runs });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return true;
    }

    if (url.pathname === "/api/settings" && request.method === "GET") {
      sendJson(response, 200, await readSettings());
      return true;
    }

    if (url.pathname === "/api/analysis-models" && request.method === "GET") {
      try {
        sendJson(response, 200, await loadAnalysisCatalog());
      } catch (error) {
        sendJson(response, 502, { error: error.message || "Analysis models could not be listed." });
      }
      return true;
    }

    if (url.pathname === "/api/analysis-agent/probe" && request.method === "POST") {
      try {
        await readRequestJson(request);
        const settings = await readSettings();
        const agent = await probeAnalysisAgent(settingsAnalysisRunOptions(settings));
        sendJson(response, 200, {
          agent,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        sendJson(response, 502, { error: error.message || "AI agent probe failed." });
      }
      return true;
    }

    if (url.pathname === "/api/settings" && request.method === "PUT") {
      try {
        const previous = await readSettings();
        const settings = await saveSettings(await readRequestJson(request));
        eventHub.publish("settings");
        if (settings.autoQueue === true && previous.autoQueue !== true && dashboardService) {
          const queueState = await readQueueState();
          const automaticAnalysis = await automaticallyQueueNewAnalyses(
            inboxFromQueue(queueState).items,
            dashboardService,
            settingsAnalysisRunOptions(settings),
          );
          if (automaticAnalysis.runs.length) {
            eventHub.publish("analysis", { queued: automaticAnalysis.runs.length });
          }
        }
        sendJson(response, 200, settings);
      } catch {
        sendJson(response, 400, { error: "Settings could not be saved." });
      }
      return true;
    }

    if (url.pathname === "/api/inbox/items" && request.method === "PUT") {
      try {
        const body = await readRequestJson(request);
        const mutations = ["done", "read"].filter((field) => typeof body[field] === "boolean");
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : null;
        const bulkDone = Boolean(
          ids?.length &&
            ids.length === body.ids.length &&
            ids.length <= 100 &&
            ids.every((id) => typeof id === "string" && id && id.length <= 200) &&
            body.id === undefined &&
            body.done === true &&
            mutations.length === 1,
        );
        if (
          !bulkDone &&
          (typeof body.id !== "string" ||
            !body.id ||
            body.id.length > 200 ||
            mutations.length !== 1)
        ) {
          throw new Error("One tracked inbox item update is required.");
        }
        const targetIds = ids ?? [body.id];
        const queueState = await readQueueState();
        const githubTargets = targetIds.map((id) => ({
          id,
          threadId: notificationThreadIdFromRecord(id, queueState.items[id]),
        }));
        const result = await mutateQueueState(
          (state) =>
            bulkDone
              ? setQueueItemsDone(state, ids)
              : mutations[0] === "done"
                ? setQueueItemDone(state, body.id, body.done)
                : setQueueItemRead(state, body.id, body.read),
          { ids: targetIds },
        );
        if (!result) throw new Error("That inbox item is not tracked.");
        let warning;
        if (bulkDone || (mutations[0] === "done" && body.done === true)) {
          warning = await syncDoneToGitHub(githubTargets);
        } else if (mutations[0] === "read" && body.read === true) {
          warning = await syncReadToGitHub(githubTargets);
        }
        eventHub.publish("inbox", { ids: targetIds });
        sendJson(response, 200, warning ? { ...result, warning } : result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return true;
    }

    if (url.pathname === "/api/inbox/items" && request.method === "POST") {
      try {
        const body = await readRequestJson(request);
        const saved = await readSettings();
        const username = await resolveGitHubUsername();
        const result = await addInboxPullRequest(body.url, {
          teammates: saved.people,
          teams: saved.teams,
          username,
        });
        eventHub.publish("inbox", { ids: [result.id] });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.status === 502 ? 502 : 400, { error: error.message });
      }
      return true;
    }

    if (url.pathname === "/api/inbox/sync" && request.method === "POST") {
      try {
        sendJson(response, 200, await scheduler.runSync());
      } catch (error) {
        sendJson(response, 502, {
          error:
            error?.code === "ENOENT"
              ? "GitHub CLI is not installed."
              : "GitHub could not be reached. Run `gh auth status` and try again.",
        });
      }
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/inbox") {
      try {
        const view = url.searchParams.get("view") === "done" ? "done" : "active";
        const offsetValue = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
        const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
        const limit = view === "done" ? 200 : 1_000;
        const queueState = await readQueueState({ limit, offset, view });
        const username = await resolveGitHubUsername();
        const inbox = inboxFromQueue(queueState, username);
        const store = await getInboxStore();
        const totals = store.queueCounts();
        response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
        response.end(
          JSON.stringify({
            ...inbox,
            counts: { ...store.activeQueueCounts(), done: totals.done },
            page: {
              hasMore: offset + Object.keys(queueState.items).length < totals[view],
              limit,
              nextOffset: offset + Object.keys(queueState.items).length,
              offset,
              total: totals[view],
              view,
            },
          }),
        );
      } catch {
        sendJson(response, 500, { error: "The local inbox could not be loaded." });
      }
      return true;
    }

    return false;
  };
}
