import {
  createMarkNotificationThreadDoneClient,
  createMarkNotificationThreadReadClient,
} from "../github-notifications.js";
import { mapLimited } from "./activity.js";
import { isLegacyNumericNotificationThreadId, validNotificationThreadId } from "./identity.js";

export const markNotificationThreadRead = createMarkNotificationThreadReadClient();
export const markNotificationThreadDone = createMarkNotificationThreadDoneClient();

export function notificationThreadIdFromRecord(id, record) {
  const notificationMatch = /^notification:(.+)$/.exec(id);
  if (notificationMatch) return validNotificationThreadId(notificationMatch[1]);
  const item = record?.item;
  return validNotificationThreadId(item?.notificationThreadId);
}

export async function syncInboxReadToGitHub(
  targets,
  { markRead = markNotificationThreadRead } = {},
) {
  const warnings = [];
  for (const { id, threadId } of targets) {
    if (!isLegacyNumericNotificationThreadId(threadId)) {
      warnings.push(`GitHub was not updated for ${id} because no notification thread id is known.`);
      continue;
    }
    try {
      await markRead(threadId);
    } catch {
      warnings.push(`GitHub could not mark ${id} as read.`);
    }
  }
  return warnings.length ? warnings.join(" ") : undefined;
}

export async function syncInboxDoneToGitHub(
  targets,
  { markDone = markNotificationThreadDone, concurrency = 5 } = {},
) {
  const warnings = [];
  const missing = [];
  const writable = [];
  for (const { id, threadId } of targets) {
    if (!isLegacyNumericNotificationThreadId(threadId)) {
      missing.push(id);
      continue;
    }
    writable.push({ id, threadId });
  }
  if (missing.length) {
    warnings.push(
      `GitHub was not updated for ${missing.join(", ")} because no notification thread id is known.`,
    );
  }
  const failed = [];
  await mapLimited(writable, concurrency, async ({ id, threadId }) => {
    try {
      await markDone(threadId);
    } catch {
      failed.push(id);
    }
  });
  if (failed.length) {
    warnings.push(`GitHub could not mark done: ${failed.join(", ")}.`);
  }
  return warnings.length ? warnings.join(" ") : undefined;
}
