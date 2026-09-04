import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildChunkDiffData } from "../src/review/diff-view-model.js";

// @git-diff-view/react needs a real DOM (it defers row rendering until mounted, and
// measures text via canvas) to actually compute and render a diff — the rest of this repo's
// webview checks only inspect bundle/data shape, which would not have caught the bug this
// test guards against: a malformed synthetic hunk that silently produces an empty diff.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;

dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  measureText: (text) => ({ width: String(text).length * 7 }),
  font: "",
});

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = FakeObserver;
dom.window.ResizeObserver = FakeObserver;
global.IntersectionObserver = FakeObserver;
dom.window.IntersectionObserver = FakeObserver;

global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { useEffect, useMemo, useRef } = React;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { DiffView, DiffModeEnum } = await import("@git-diff-view/react");

function DiffChunkView({ chunk }) {
  const { data, realNewLineNumbers, realOldLineNumbers, registerHighlighter } = useMemo(
    () => buildChunkDiffData(chunk),
    [chunk],
  );
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const applyRealLineNumbers = () => {
      container.querySelectorAll("[data-line-old-num]").forEach((el) => {
        const real = realOldLineNumbers[Number(el.getAttribute("data-line-old-num")) - 1];

        if (real != null && el.textContent !== String(real)) {
          el.textContent = String(real);
        }
      });

      container.querySelectorAll("[data-line-new-num]").forEach((el) => {
        const real = realNewLineNumbers[Number(el.getAttribute("data-line-new-num")) - 1];

        if (real != null && el.textContent !== String(real)) {
          el.textContent = String(real);
        }
      });
    };

    applyRealLineNumbers();
    const observer = new MutationObserver(applyRealLineNumbers);
    observer.observe(container, { characterData: true, childList: true, subtree: true });

    return () => observer.disconnect();
  }, [realNewLineNumbers, realOldLineNumbers]);

  return React.createElement(
    "div",
    { ref: containerRef },
    React.createElement(DiffView, {
      className: "m-0 w-max min-w-full max-w-none overflow-visible",
      data,
      diffViewFontSize: 11,
      diffViewHighlight: true,
      diffViewMode: DiffModeEnum.Unified,
      diffViewWrap: false,
      registerHighlighter,
    }),
  );
}

const chunk = {
  file: "config.js",
  lines: [
    {
      content: "    width: 24,",
      oldLine: 82,
      newLine: null,
      syntaxTokens: [{ content: "    width: 24," }],
      type: "del",
    },
    {
      content: "    width: 36,",
      oldLine: null,
      newLine: 69,
      syntaxTokens: [{ content: "    width: 36," }],
      type: "add",
    },
  ],
};

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

await act(async () => {
  root.render(React.createElement(DiffChunkView, { chunk }));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});

const html = container.innerHTML;
const oldGutterNumbers = [...container.querySelectorAll("[data-line-old-num]")].map(
  (el) => el.textContent,
);
const newGutterNumbers = [...container.querySelectorAll("[data-line-new-num]")].map(
  (el) => el.textContent,
);
await act(async () => {
  root.unmount();
});

assert.match(
  html,
  /24/,
  "the deleted line's content should render, not collapse into an empty diff",
);
assert.match(html, /36/, "the added line's content should render, not collapse into an empty diff");
assert.match(
  html,
  /data-diff-highlight[^>]*--diff-del-content-highlight--[^>]*>24</,
  "the changed substring on the del line should get the intra-line diff highlight",
);
assert.match(
  html,
  /data-diff-highlight[^>]*--diff-add-content-highlight--[^>]*>36</,
  "the changed substring on the add line should get the intra-line diff highlight",
);
assert.deepEqual(
  oldGutterNumbers,
  ["82"],
  "the old-side gutter should show the real PR line number, not the synthetic 1-based hunk position",
);
assert.deepEqual(
  newGutterNumbers,
  ["69"],
  "the new-side gutter should show the real PR line number, not the synthetic 1-based hunk position",
);

console.log("diff view render checks passed");
