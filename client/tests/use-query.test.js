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
global.AbortController = dom.window.AbortController;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { readJson, useQuery } = await import("../src/hooks/use-query.js");

test("readJson throws on non-OK responses", async () => {
  await assert.rejects(
    () => readJson({ ok: false, status: 500, json: async () => ({ error: "nope" }) }),
    /nope/,
  );
  assert.deepEqual(await readJson({ ok: true, json: async () => ({ ok: true }) }), { ok: true });
});

test("useQuery settles loading/data/error and ignores stale responses", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  let latest;

  function Probe({ category }) {
    latest = useQuery({
      queryKey: ["bookmarks", category],
      queryFn: async () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe, { category: "books" })));
    assert.equal(latest.status, "pending");
    assert.equal(latest.data, undefined);

    await act(async () => root.render(React.createElement(Probe, { category: "movies" })));
    assert.equal(calls, 2);
    assert.equal(latest.data, undefined);
    assert.equal(latest.error, undefined);

    await act(async () => first.resolve({ category: "books" }));
    assert.equal(latest.data, undefined);

    await act(async () => second.resolve({ category: "movies" }));
    assert.equal(latest.status, "success");
    assert.deepEqual(latest.data, { category: "movies" });
    assert.equal(latest.error, undefined);
  } finally {
    await act(async () => root.unmount());
  }
});

test("useQuery clears a previous error when the key changes", async () => {
  let latest;

  function Probe({ category }) {
    latest = useQuery({
      queryKey: ["bookmarks", category],
      queryFn: async ({ queryKey }) => {
        if (queryKey[1] === "bad") throw new Error("boom");
        return { category: queryKey[1] };
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe, { category: "bad" })));
    await act(async () => {});
    assert.equal(latest.status, "error");
    assert.match(latest.error.message, /boom/);

    await act(async () => root.render(React.createElement(Probe, { category: "good" })));
    await act(async () => {});
    assert.equal(latest.status, "success");
    assert.deepEqual(latest.data, { category: "good" });
    assert.equal(latest.error, undefined);
  } finally {
    await act(async () => root.unmount());
  }
});

test("useQuery refetch keeps prior data while pending", async () => {
  const second = deferred();
  let calls = 0;
  let latest;

  function Probe() {
    latest = useQuery({
      queryKey: ["once"],
      queryFn: async () => {
        calls += 1;
        if (calls === 1) return { n: 1 };
        return second.promise;
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => {});
    assert.deepEqual(latest.data, { n: 1 });

    let refetchDone;
    await act(async () => {
      refetchDone = latest.refetch();
    });
    assert.equal(latest.status, "pending");
    assert.deepEqual(latest.data, { n: 1 });

    await act(async () => second.resolve({ n: 2 }));
    await act(async () => refetchDone);
    assert.deepEqual(latest.data, { n: 2 });
    assert.equal(latest.status, "success");
  } finally {
    await act(async () => root.unmount());
  }
});

test("useQuery can be disabled", async () => {
  let calls = 0;
  let latest;

  function Probe({ enabled }) {
    latest = useQuery({
      enabled,
      queryKey: ["off"],
      queryFn: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe, { enabled: false })));
    assert.equal(latest.status, "idle");
    assert.equal(calls, 0);

    await act(async () => root.render(React.createElement(Probe, { enabled: true })));
    await act(async () => {});
    assert.equal(calls, 1);
    assert.equal(latest.status, "success");
  } finally {
    await act(async () => root.unmount());
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
