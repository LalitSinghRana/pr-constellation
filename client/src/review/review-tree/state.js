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

export function readReviewRunId() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[0] === "reviews" && parts[2] && !parts[2].includes(".") ? parts[2] : "";
}
