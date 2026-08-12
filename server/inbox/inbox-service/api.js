import { probeAnalysisAgent } from "../../analysis/analysis-agent-probe.js";
import { host } from "../../runtime-config.js";
import {
  automaticallyQueueNewAnalyses,
  enqueueMissingAnalyses,
  normalizeAnalysisCandidate,
} from "./analysis-queue.js";
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
  getInboxStore,
  getNotifications,
  inboxFromQueue,
  markGitHubNotificationDone,
  mutateQueueState,
  prKey,
  readQueueState,
  readSettings,
  saveSettings,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  validNotificationThreadId,
}) {
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
          model: settings.defaultAnalysisModel,
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
        const runs = await enqueueMissingAnalyses(
          Array.isArray(body.pullRequests) ? body.pullRequests : [],
          dashboardService,
          { model: settings.defaultAnalysisModel },
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

    if (url.pathname === "/api/analysis-agent/probe" && request.method === "POST") {
      try {
        await readRequestJson(request);
        const settings = await readSettings();
        const agent = await probeAnalysisAgent({ model: settings.defaultAnalysisModel });
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
            { model: settings.defaultAnalysisModel },
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
          throw new Error("One tracked queue item update is required.");
        }
        const targetIds = ids ?? [body.id];
        const result = await mutateQueueState(
          (state) =>
            bulkDone
              ? setQueueItemsDone(state, ids)
              : mutations[0] === "done"
                ? setQueueItemDone(state, body.id, body.done)
                : setQueueItemRead(state, body.id, body.read),
          { ids: targetIds },
        );
        if (!result) throw new Error("That queue item is not tracked.");
        if (body.done) {
          const state = await readQueueState();
          const threadIds = new Set(
            targetIds.flatMap((id) => {
              const stored = state.items[id]?.item?.notificationThreadId;
              const threadId =
                /^notification:(\d+)$/.exec(id)?.[1] ?? validNotificationThreadId(stored);
              return threadId ? [threadId] : [];
            }),
          );
          try {
            if (threadIds.size < targetIds.length) {
              for (const { pr } of (await getNotifications()).pullRequests) {
                if (targetIds.includes(prKey(pr)) && pr.notificationThreadId) {
                  threadIds.add(pr.notificationThreadId);
                }
              }
            }
            const outcomes = await Promise.allSettled(
              [...threadIds].map(markGitHubNotificationDone),
            );
            if (outcomes.some(({ status }) => status === "rejected")) {
              throw new Error("GitHub notification update failed");
            }
          } catch {
            result.warning = "Saved locally, but GitHub could not mark the notification done.";
          }
        }
        eventHub.publish("inbox", { ids: targetIds });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return true;
    }

    if (url.pathname === "/api/inbox/sync" && request.method === "POST") {
      try {
        sendJson(response, 200, await scheduler.runFullSync());
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

    if (url.pathname === "/api/inbox/notifications/sync" && request.method === "POST") {
      try {
        sendJson(response, 200, await scheduler.runNotificationSync());
      } catch (error) {
        sendJson(response, 502, {
          error:
            error?.code === "ENOENT"
              ? "GitHub CLI is not installed."
              : "GitHub notifications could not be refreshed.",
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
        const saved = await readSettings();
        const inbox = inboxFromQueue(queueState, saved.username || queueState.sync.username);
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
        sendJson(response, 500, { error: "The local queue could not be loaded." });
      }
      return true;
    }

    return false;
  };
}
