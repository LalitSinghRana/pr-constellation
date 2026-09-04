import createMiddleEllipsis from "@dynamic-middle-ellipsis/react";
import { customFontWidthMap } from "./custom-font-family-map.js";

// Truncation measures against offsetParent, so callers keep the text wrapper `relative`.
export const MiddleEllipsis = createMiddleEllipsis({ customFontWidthMap });
