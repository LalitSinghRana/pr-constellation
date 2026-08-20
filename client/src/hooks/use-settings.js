import { readJson, useQuery } from "@/hooks/use-query.js";
import { applyReviewUiSettings } from "../../../shared/review-ui-settings.js";

export async function fetchSettings({ signal } = {}) {
  const response = await fetch("/api/settings", signal ? { signal } : undefined);
  return applyReviewUiSettings(await readJson(response));
}

export async function putSettings(settings) {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(applyReviewUiSettings(settings)),
  });
  return applyReviewUiSettings(await readJson(response));
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => fetchSettings({ signal }),
  });
}
