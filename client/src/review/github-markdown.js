import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";

const githubMediaHostPattern = /^(?:[a-z0-9-]+\.)*(?:github(?:usercontent)?\.com)$/i;
const imageExtensionPattern = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const videoExtensionPattern = /\.(?:mov|mp4|webm)(?:$|[?#])/i;
const githubAttachmentPathPattern = /^\/user-attachments\/assets\/[0-9a-f-]+\/?$/i;

export const githubMarkdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames, "path", "source", "svg", "track", "video"],
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes.div || []),
      ["className", "markdown-alert", /^markdown-alert-(note|tip|important|warning|caution)$/],
    ],
    path: ["d"],
    p: [...(defaultSchema.attributes.p || []), ["className", "markdown-alert-title"]],
    source: ["src", "type"],
    svg: ["ariaHidden", "className", "height", "viewBox", "width"],
    track: ["kind", "label", "src", "srcLang"],
    video: ["controls", "muted", "playsInline", "preload", "src"],
  },
};

export function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function isGitHubMediaUrl(value) {
  const url = parseHttpUrl(value);
  return Boolean(url && githubMediaHostPattern.test(url.hostname));
}

export function isGitHubAttachmentUrl(value) {
  const url = parseHttpUrl(value);
  return Boolean(
    url &&
      githubMediaHostPattern.test(url.hostname) &&
      githubAttachmentPathPattern.test(url.pathname),
  );
}

export function isImageUrl(value) {
  return imageExtensionPattern.test(String(value || ""));
}

export function isVideoUrl(value) {
  return videoExtensionPattern.test(String(value || ""));
}

export function shouldRenderAsMedia(value) {
  return isGitHubAttachmentUrl(value) || isImageUrl(value) || isVideoUrl(value);
}

export function guessMediaKind(value) {
  return isVideoUrl(value) ? "video" : "image";
}

export const githubMarkdownRemarkPlugins = [remarkGfm, remarkAlert];
export const githubMarkdownRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, githubMarkdownSanitizeSchema],
];

export function proxiedMediaUrl(value) {
  const url = parseHttpUrl(value);
  if (!url || !isGitHubMediaUrl(url.href)) {
    return String(value || "");
  }
  return `/api/github-media?url=${encodeURIComponent(url.href)}`;
}
