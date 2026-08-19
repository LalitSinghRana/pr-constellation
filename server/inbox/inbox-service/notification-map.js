import { getGitHubNotifications } from "../github-notifications.js";
import { isMyPrNotification, validNotificationThreadId } from "./identity.js";
import { addSignal, addSource } from "./pr-items.js";

export function prFromNotification(thread) {
  if (thread.subject?.type !== "PullRequest" || !thread.subject.url) return null;

  try {
    const number = Number.parseInt(new URL(thread.subject.url).pathname.split("/").at(-1), 10);
    const repository = thread.repository?.full_name;
    if (!repository || !Number.isInteger(number)) return null;
    return {
      number,
      title: thread.subject.title,
      url: `https://github.com/${repository}/pull/${number}`,
      repository: { nameWithOwner: repository },
      updatedAt: thread.updated_at,
      state: "UNKNOWN",
      notificationThreadId: validNotificationThreadId(thread.id),
    };
  } catch {
    return null;
  }
}

export function notificationWebUrl(thread) {
  const repositoryUrl =
    thread.repository?.html_url ?? `https://github.com/${thread.repository?.full_name ?? ""}`;
  try {
    const parts = new URL(thread.subject.url).pathname.replace(/^\/repos\//, "").split("/");
    const [owner, repository, resource, value] = parts;
    const route = {
      pulls: "pull",
      commits: "commit",
      issues: "issues",
      discussions: "discussions",
    }[resource];
    return route && owner && repository && value
      ? `https://github.com/${owner}/${repository}/${route}/${value}`
      : repositoryUrl;
  } catch {
    return repositoryUrl;
  }
}

export function otherNotificationFromThread(thread) {
  if (thread.subject?.type === "PullRequest") return null;
  return {
    id: `notification:${thread.id}`,
    kind: "notification",
    title: thread.subject?.title ?? "GitHub notification",
    url: notificationWebUrl(thread),
    repository: thread.repository?.full_name ?? "GitHub",
    subjectType: thread.subject?.type ?? "Notification",
    reason: thread.reason,
    updatedAt: thread.updated_at,
    unread: Boolean(thread.unread),
    notificationThreadId: validNotificationThreadId(thread.id),
  };
}

export async function getNotifications() {
  const result = await getGitHubNotifications();
  const threads = result.threads;
  const pullRequests = threads
    .map((thread) => ({ thread, pr: prFromNotification(thread) }))
    .filter(({ pr }) => pr);
  return {
    pollIntervalSeconds: result.pollIntervalSeconds,
    total: threads.length,
    pullRequests,
    other: threads.map(otherNotificationFromThread).filter(Boolean),
  };
}

export function seedNotificationPullRequests(items, pullRequestNotifications) {
  for (const { thread, pr } of pullRequestNotifications) {
    addSource(items, pr, "notification", thread.reason);
    if (thread.reason === "mention") addSignal(items, pr, "direct-mention");
    if (thread.reason === "team_mention") addSignal(items, pr, "team-mention");
  }
  return items;
}

export function seedAuthoredPullRequests(items, pullRequests) {
  for (const pr of pullRequests) addSource(items, pr, "authored");
  return items;
}

export function excludeAuthoredPullRequestNotifications(
  pullRequestNotifications,
  authoredIds = [],
) {
  const authored = authoredIds instanceof Set ? authoredIds : new Set(authoredIds);
  return pullRequestNotifications.filter(({ pr }) => !isMyPrNotification(pr, authored));
}
