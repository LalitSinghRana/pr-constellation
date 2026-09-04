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
const { useMutation } = await import("../src/hooks/use-mutation.js");

test("useMutation tracks pending success and exposes variables", async () => {
  const deferred = createDeferred();
  let latest;
  const onSuccessCalls = [];

  function Probe() {
    latest = useMutation({
      mutationFn: async (variables) => {
        await deferred.promise;
        return { saved: variables.value };
      },
      onSuccess: (data, variables) => {
        onSuccessCalls.push({ data, variables });
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(latest.status, "idle");

    let pending;
    await act(async () => {
      pending = latest.mutateAsync({ value: 1 });
    });
    assert.equal(latest.status, "pending");
    assert.deepEqual(latest.variables, { value: 1 });

    await act(async () => deferred.resolve());
    await act(async () => pending);
    assert.equal(latest.status, "success");
    assert.deepEqual(latest.data, { saved: 1 });
    assert.deepEqual(onSuccessCalls, [{ data: { saved: 1 }, variables: { value: 1 } }]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("useMutation records errors and still rejects mutateAsync", async () => {
  let latest;
  let onErrorMessage = "";

  function Probe() {
    latest = useMutation({
      mutationFn: async () => {
        throw new Error("nope");
      },
      onError: (error) => {
        onErrorMessage = error.message;
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    let rejected;
    await act(async () => {
      rejected = latest.mutateAsync({ id: "x" }).catch((error) => error);
    });
    const error = await act(async () => rejected);
    assert.match(error.message, /nope/);
    assert.equal(latest.status, "error");
    assert.match(latest.error.message, /nope/);
    assert.equal(onErrorMessage, "nope");
  } finally {
    await act(async () => root.unmount());
  }
});

test("useMutation mutate swallows rejection", async () => {
  let latest;

  function Probe() {
    latest = useMutation({
      mutationFn: async () => {
        throw new Error("boom");
      },
    });
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest.mutate({}));
    await act(async () => {});
    assert.equal(latest.status, "error");
    assert.match(latest.error.message, /boom/);
  } finally {
    await act(async () => root.unmount());
  }
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
