export const REVIEW_TREE_DENSITY_MODES = Object.freeze(["0.1x", "1x", "10x"]);
export const DEFAULT_REVIEW_TREE_DENSITY = "1x";
export const REVIEW_CONTENT_TABS = Object.freeze(["conversation", "trees"]);
export const DEFAULT_REVIEW_CONTENT_TAB = "conversation";
export const FILE_VIEW_MODES = Object.freeze(["tree", "source"]);
export const DEFAULT_FILE_VIEW_MODE = "tree";

export function normalizeReviewUiSettings(value = {}) {
  return {
    reviewTreeDensity: REVIEW_TREE_DENSITY_MODES.includes(value.reviewTreeDensity)
      ? value.reviewTreeDensity
      : DEFAULT_REVIEW_TREE_DENSITY,
    defaultReviewTab: REVIEW_CONTENT_TABS.includes(value.defaultReviewTab)
      ? value.defaultReviewTab
      : DEFAULT_REVIEW_CONTENT_TAB,
    defaultFileViewMode: FILE_VIEW_MODES.includes(value.defaultFileViewMode)
      ? value.defaultFileViewMode
      : DEFAULT_FILE_VIEW_MODE,
  };
}

export function applyReviewUiSettings(settings = {}) {
  return {
    ...settings,
    ...normalizeReviewUiSettings(settings),
  };
}
