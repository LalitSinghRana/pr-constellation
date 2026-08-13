import { readJson, useQuery } from "@/hooks/use-query.js";

export async function fetchSettings({ signal } = {}) {
  const response = await fetch("/api/settings", signal ? { signal } : undefined);
  return readJson(response);
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => fetchSettings({ signal }),
  });
}
