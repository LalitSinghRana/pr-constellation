import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAnalysisDashboard } = await import("../src/hooks/use-analysis-dashboard.js");
const { useInbox } = await import("../src/hooks/use-inbox.js");

test("initial SSE readiness revalidates inbox and analysis state", async () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const timers = new Map();
  let nextTimer = 0;
  const calls = { analyses: 0, inbox: 0 };
  FakeEventSource.instances = [];
  global.EventSource = FakeEventSource;
  global.fetch = async (url) => {
    if (url === "/api/analyses") {
      calls.analyses++;
      return jsonResponse({ prs: [], queue: { activeRunId: null, queuedRunIds: [] } });
    }
    calls.inbox++;
    return jsonResponse(inboxPayload(`request-${calls.inbox}`));
  };
  window.setTimeout = (callback) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(BothHooksProbe)));
    assert.deepEqual(calls, { analyses: 1, inbox: 1 });

    await act(async () => {
      for (const events of FakeEventSource.instances) events.emit("ready");
      for (const callback of timers.values()) callback();
      timers.clear();
      await Promise.resolve();
    });
    assert.deepEqual(calls, { analyses: 2, inbox: 2 });
  } finally {
    await act(async () => root.unmount());
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
});

test("a background inbox refresh cannot leave foreground loading stuck", async () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;
  const foreground = deferred();
  const background = deferred();
  let requestCount = 0;
  let inbox;
  FakeEventSource.instances = [];
  global.EventSource = FakeEventSource;
  global.fetch = () => (++requestCount === 1 ? foreground.promise : background.promise);

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(InboxProbe, { capture: setInbox })));
    assert.equal(inbox.loading, true);

    let backgroundRefresh;
    await act(async () => {
      backgroundRefresh = inbox.refresh(true);
    });
    background.resolve(jsonResponse(inboxPayload("background")));
    await act(async () => backgroundRefresh);
    assert.equal(inbox.loading, true);
    assert.equal(inbox.data.username, "background");

    foreground.resolve(jsonResponse(inboxPayload("foreground")));
    await act(async () => foreground.promise);
    assert.equal(inbox.loading, false);
    assert.equal(inbox.data.username, "background");
  } finally {
    await act(async () => root.unmount());
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
  }

  function setInbox(value) {
    inbox = value;
  }
});

function BothHooksProbe() {
  useInbox();
  useAnalysisDashboard();
  return null;
}

function InboxProbe({ capture }) {
  capture(useInbox());
  return null;
}

class FakeEventSource {
  static instances = [];

  #listeners = new Map();

  constructor() {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, callback) {
    this.#listeners.set(type, callback);
  }

  emit(type) {
    this.#listeners.get(type)?.();
  }

  close() {}
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}

function inboxPayload(username) {
  return {
    username,
    fetchedAt: null,
    items: [],
    notifications: [],
    repositories: [],
    notificationSummary: { total: 0, pullRequests: 0, nonPullRequests: 0 },
    counts: {},
    page: { hasMore: false, limit: 1_000, nextOffset: 0, offset: 0, total: 0 },
    warnings: [],
  };
}
