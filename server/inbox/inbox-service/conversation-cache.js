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
  { fetchConversation = fetchPullRequestConversation, store } = {},
) {
  const candidates = new Map();
  for (const item of items) {
    const coordinates = conversationCoordinates(item);
    if (coordinates) {
      candidates.set(`${coordinates.owner}/${coordinates.repo}#${coordinates.number}`, coordinates);
    }
  }

  const conversationStore = store;
  const outcomes = await mapLimited([...candidates.values()], 3, async (coordinates) => {
    try {
      const conversation = await fetchConversation(coordinates);
      conversationStore.saveReviewConversation({ ...coordinates, conversation });
      return true;
    } catch {
      return false;
    }
  });
  return {
    cached: outcomes.filter(Boolean).length,
    warnings: outcomes.some((cached) => !cached)
      ? ["Some pull request conversations could not be cached."]
      : [],
  };
}
