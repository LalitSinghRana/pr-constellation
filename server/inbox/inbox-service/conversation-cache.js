import { fetchPullRequestConversation } from "../../review/github-review-client.js";

async function mapLimited(values, limit, callback) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await callback(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export function conversationCoordinates(item) {
  if (item?.kind === "notification" || !Number.isInteger(item?.number)) return null;
  const [owner, repo, ...rest] = String(item.repository || "").split("/");
  return owner && repo && rest.length === 0 ? { number: item.number, owner, repo } : null;
}

export async function cacheReviewConversations(
  items,
  { fetchConversation = fetchPullRequestConversation, refreshIds = null, store } = {},
) {
  const candidates = new Map();
  for (const item of items) {
    const coordinates = conversationCoordinates(item);
    if (coordinates) {
      candidates.set(`${coordinates.owner}/${coordinates.repo}#${coordinates.number}`, {
        coordinates,
        id: item.id,
      });
    }
  }

  const conversationStore = store;
  const outcomes = await mapLimited([...candidates.values()], 3, async ({ coordinates, id }) => {
    const hasCachedConversation = Boolean(conversationStore.readReviewConversation(coordinates));
    const shouldFetch = !hasCachedConversation || (refreshIds instanceof Set && refreshIds.has(id));
    if (!shouldFetch) return "skipped";
    try {
      const conversation = await fetchConversation(coordinates);
      conversationStore.saveReviewConversation({ ...coordinates, conversation });
      return "cached";
    } catch {
      return "failed";
    }
  });
  return {
    cached: outcomes.filter((outcome) => outcome === "cached").length,
    warnings: outcomes.some((outcome) => outcome === "failed")
      ? ["Some pull request conversations could not be cached."]
      : [],
  };
}
