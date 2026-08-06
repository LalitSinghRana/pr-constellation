import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function formatCountLabel(count, singular, plural = `${singular}s`) {
  const safeCount = Number.isFinite(count) ? count : 0;
  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}
