import { useEffect, useState } from "react";

export function usePersistentStringSet(storageKey) {
  const [values, setValues] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
      return new Set(Array.isArray(stored) ? stored : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...values]));
    } catch {
      // Persistence is optional when the review runs in a restricted browser.
    }
  }, [storageKey, values]);

  return [values, setValues];
}

export function usePersistentFileViewModeOverrides(storageKey) {
  const [overrides, setOverrides] = useState(() => readFileViewModeOverrides(storageKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(overrides)));
    } catch {
      // Persistence is optional when the review runs in a restricted browser.
    }
  }, [overrides, storageKey]);

  return [overrides, setOverrides];
}

export function readFileViewModeOverrides(storageKey) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    return parseFileViewModeOverrides(stored);
  } catch {
    return new Map();
  }
}

export function parseFileViewModeOverrides(stored) {
  if (Array.isArray(stored)) {
    return new Map(
      stored
        .filter((fileId) => typeof fileId === "string" && fileId.length > 0)
        .map((fileId) => [fileId, "source"]),
    );
  }

  if (!stored || typeof stored !== "object") {
    return new Map();
  }

  return new Map(
    Object.entries(stored).filter(
      ([fileId, viewMode]) =>
        typeof fileId === "string" &&
        fileId.length > 0 &&
        (viewMode === "tree" || viewMode === "source"),
    ),
  );
}

export function resolveFileViewMode(fileId, overrides = new Map(), defaultFileViewMode = "tree") {
  const override = overrides.get(fileId);
  if (override === "tree" || override === "source") {
    return override;
  }
  return defaultFileViewMode === "source" ? "source" : "tree";
}

export function readReviewSlug() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[0] === "reviews" && parts[1] ? parts[1] : "";
}

export function readReviewRunId() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[0] === "reviews" && parts[2] && !parts[2].includes(".") ? parts[2] : "";
}

export function resolveActiveStackId(stacks, selectedStackId) {
  if (stacks.some((stack) => stack.id === selectedStackId)) {
    return selectedStackId;
  }
  return stacks[0]?.id ?? null;
}
