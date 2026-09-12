export const usernamePattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
export const teamPattern =
  /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i;
export const repositoryNamePattern = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

const notificationThreadIdPattern = /^[A-Za-z0-9_:=-]{1,128}$/;

export function validNotificationThreadId(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!id || id.includes("/") || id.includes("..") || /\s/.test(id)) return null;
  return notificationThreadIdPattern.test(id) ? id : null;
}

export function isLegacyNumericNotificationThreadId(value) {
  return /^\d+$/.test(typeof value === "string" || typeof value === "number" ? String(value) : "");
}

export function repositoryName(pr) {
  return typeof pr.repository === "string" ? pr.repository : pr.repository.nameWithOwner;
}

export function prKey(pr) {
  return `${repositoryName(pr)}#${pr.number}`;
}

export function isMyPrNotification(pr, authoredIds = new Set()) {
  return Boolean(pr && authoredIds.has(prKey(pr)));
}
