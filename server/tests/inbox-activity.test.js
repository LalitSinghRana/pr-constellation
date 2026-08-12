import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleForQueueItem } from "../../shared/queue-policy.js";
import { refreshNotificationItems } from "../inbox/inbox-service.js";

test("a notification refresh keeps commented pull requests reviewed", async () => {
  const id = "PicnicSupermarket/picnic-store-config#5011";
  const items = new Map([
    [
      id,
      {
        id,
        latestReviewState: null,
        notificationUpdatedAt: "2026-08-10T08:40:00Z",
        number: 5011,
        repository: "PicnicSupermarket/picnic-store-config",
        reviewed: false,
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
  ]);
  const touched = new Set();
  const activity = {
    author: { login: "FlorBosch" },
    createdAt: "2026-08-07T11:28:43Z",
    headRefOid: "head-sha",
    isDraft: false,
    labels: { nodes: [] },
    mergedAt: null,
    reviewDecision: "REVIEW_REQUIRED",
    reviews: {
      nodes: [
        {
          author: { login: "LalitSinghRana" },
          state: "COMMENTED",
          submittedAt: "2026-08-10T08:45:04Z",
        },
      ],
    },
    state: "OPEN",
    title: "Basket layout",
    updatedAt: "2026-08-10T08:46:30Z",
    url: "https://github.com/PicnicSupermarket/picnic-store-config/pull/5011",
  };

  await refreshNotificationItems(
    items,
    [
      {
        pr: {
          number: 5011,
          repository: { nameWithOwner: "PicnicSupermarket/picnic-store-config" },
        },
        thread: { updated_at: "2026-08-10T08:46:31Z" },
      },
    ],
    touched,
    { getActivity: async () => activity, username: "LalitSinghRana" },
  );

  const item = items.get(id);
  assert.equal(item.latestReviewState, "COMMENTED");
  assert.equal(item.reviewed, true);
  assert.equal(lifecycleForQueueItem(item), "reviewed");
  assert.equal(touched.has(id), true);

  const authoredId = "LalitSinghRana/pr-review-cockpit#16";
  items.set(authoredId, {
    ...items.get(id),
    authored: false,
    id: authoredId,
    notificationUpdatedAt: "2026-08-10T08:40:00Z",
    number: 16,
    repository: "LalitSinghRana/pr-review-cockpit",
  });
  await refreshNotificationItems(
    items,
    [
      {
        pr: { number: 16, repository: { nameWithOwner: "LalitSinghRana/pr-review-cockpit" } },
        thread: { updated_at: "2026-08-10T08:46:31Z" },
      },
    ],
    touched,
    {
      getActivity: async () => ({ ...activity, author: { login: "LalitSinghRana" } }),
      username: "LalitSinghRana",
    },
  );

  assert.equal(lifecycleForQueueItem(items.get(authoredId)), "mine");
});
