export const usernamePattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
export const teamPattern =
  /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i;
export const repositoryNamePattern = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export function validNotificationThreadId(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d+$/.test(id) ? id : null;
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
