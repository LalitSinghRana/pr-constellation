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

export function readReviewSlug() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[0] === "reviews" && parts[1] ? parts[1] : "";
}

export function readReviewData() {
  return readJsonScript("pr-review-data", {});
}

export function readTreeData() {
  return readJsonScript("pr-analysis-data", null);
}

function readJsonScript(id, fallback) {
  const target = document.getElementById(id);
  return target ? JSON.parse(target.textContent) : fallback;
}
