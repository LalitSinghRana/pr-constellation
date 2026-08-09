import { defaultSchema } from "rehype-sanitize";

export const githubMarkdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames, "path", "svg"],
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes.div || []),
      ["className", "markdown-alert", /^markdown-alert-(note|tip|important|warning|caution)$/],
    ],
    path: ["d"],
    p: [...(defaultSchema.attributes.p || []), ["className", "markdown-alert-title"]],
    svg: ["ariaHidden", "className", "height", "viewBox", "width"],
  },
};
