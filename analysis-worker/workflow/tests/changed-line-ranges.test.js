import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDiffInventory } from "../03-build-diff-inventory/diff-inventory.js";
import { validateReviewAnalysis } from "../05-validate-candidate/validate-analysis.js";
import { materializeLineOwnership } from "../07-run-retry-loop/review-analysis/structured-diff.js";
import {
  expandChangedLineRanges,
  indexHunkLineLocations,
  validateSectionChangedLineRanges,
} from "../changed-line-ranges.js";

const importGapDiff = `diff --git a/src/example.tsx b/src/example.tsx
index 0000000..1111111 100644
--- a/src/example.tsx
+++ b/src/example.tsx
@@ -3,14 +3,22 @@
 import { Icon } from '@acme/ui';
 import { useCallback } from 'react';
 import { StyleSheet } from 'react-native';
+import { useQueuedAction } from '../../../data/repository';
+import { runAction } from '../../../data/tasks/run-action.ts';
 import { GradientImageFallback } from '../../../components/image/gradient-image-fallback.tsx';
 import { Image } from '../../../components/image/image.tsx';
 import { ItemTitle } from '../../../components/item-title/item-title.tsx';
+import type { ActionResult } from '../../../utils/analytics/types.ts';
 import { createThemedStyles } from '../../../utils/create-themed-styles.ts';
+import { triggerHapticFeedback } from '../../../utils/haptic-feedback.ts';
+import { useTrackInteraction } from '../../../utils/interactions/use-track-interaction.ts';
+import { localize } from '../../../utils/localize.ts';
 import type { RowViewModel } from '../view-models/list-view-model.type.ts';
+import SECTION_COPY from './section.copy.ts';
 
 const IMAGE_SIZE = 92;
 const CHEVRON_CONTROL_SIZE = 44;
+const DELETE_CONTROL_SIZE = 44;
 
 const themedStyles = createThemedStyles((theme) => ({
   chevron: {
`;

const crossHunkDiff = `diff --git a/src/multi.js b/src/multi.js
index 0000000..1111111 100644
--- a/src/multi.js
+++ b/src/multi.js
@@ -1 +1 @@
-const first = 1;
+const first = 2;
@@ -10 +10 @@
-const second = 1;
+const second = 2;
`;

describe("changed-line-ranges", () => {
  it("expands context end boundaries to changed lines inside the span", () => {
    const inventory = createDiffInventory(importGapDiff);
    const file = inventory.files[0];
    const locations = indexHunkLineLocations(inventory);
    const hunk = file.hunks[0];
    const importChangedLineIds = [
      "file-1:hunk-1:line-4",
      "file-1:hunk-1:line-5",
      "file-1:hunk-1:line-9",
      "file-1:hunk-1:line-11",
      "file-1:hunk-1:line-12",
      "file-1:hunk-1:line-13",
      "file-1:hunk-1:line-15",
    ];

    const expanded = expandChangedLineRanges({
      file,
      locations,
      section: {
        id: "imports",
        changedLineRanges: [
          {
            start: "file-1:hunk-1:line-4",
            end: "file-1:hunk-1:line-17",
          },
        ],
      },
    });

    assert.deepEqual(expanded, importChangedLineIds);
    assert.equal(hunk.lines[16].id, "file-1:hunk-1:line-17");
    assert.equal(hunk.lines[16].kind, "context");
  });

  it("expands context start boundaries forward to the next changed lines", () => {
    const inventory = createDiffInventory(importGapDiff);
    const file = inventory.files[0];
    const locations = indexHunkLineLocations(inventory);

    const expanded = expandChangedLineRanges({
      file,
      locations,
      section: {
        id: "delete-size",
        changedLineRanges: [
          {
            start: "file-1:hunk-1:line-17",
            end: "file-1:hunk-1:line-19",
          },
        ],
      },
    });

    assert.deepEqual(expanded, ["file-1:hunk-1:line-19"]);
  });

  it("still rejects cross-hunk ranges", () => {
    const inventory = createDiffInventory(crossHunkDiff);
    const file = inventory.files[0];
    const locations = indexHunkLineLocations(inventory);
    const [firstHunk, secondHunk] = file.hunks;

    assert.throws(
      () =>
        expandChangedLineRanges({
          file,
          locations,
          section: {
            id: "cross-hunk",
            changedLineRanges: [
              {
                start: firstHunk.changedLineIds[0],
                end: secondHunk.changedLineIds.at(-1),
              },
            ],
          },
        }),
      /stay within one hunk/,
    );
  });

  it("materializes and validates context-boundary section trees end to end", () => {
    const inventory = createDiffInventory(importGapDiff);
    const file = inventory.files[0];
    const importChangedLineIds = file.changedLineIds.filter(
      (lineId) => lineId !== "file-1:hunk-1:line-19",
    );
    const candidate = {
      schemaVersion: "pr-review-trees/v1",
      intent: "Add row delete control.",
      summary: "Row delete wiring.",
      confidence: 0.9,
      fileTree: { branches: [] },
      files: [
        {
          id: file.id,
          path: file.path,
          reviewPriority: "primary",
          changeKind: "runtime",
          explanation: "Row delete wiring.",
          sectionTree: {
            sections: [
              {
                id: "imports",
                title: "Delete dependency wiring",
                reviewPriority: "skim",
                changeKind: "imports",
                explanation: "New hooks and copy load before the delete control renders.",
                changedLineRanges: [
                  {
                    start: "file-1:hunk-1:line-4",
                    end: "file-1:hunk-1:line-17",
                  },
                ],
              },
              {
                id: "delete-size",
                title: "Delete control size",
                reviewPriority: "secondary",
                changeKind: "runtime",
                explanation: "Sizing constant for delete control.",
                changedLineRanges: [
                  {
                    start: "file-1:hunk-1:line-19",
                    end: "file-1:hunk-1:line-19",
                  },
                ],
              },
            ],
            branches: [
              {
                parentId: "imports",
                childId: "delete-size",
                order: 0,
                explanation: "Delete sizing follows the new imports.",
              },
            ],
          },
        },
      ],
    };

    const materialized = materializeLineOwnership(candidate, { inventory });
    const analysis = {
      schemaVersion: "pr-review-analysis/v1",
      intent: candidate.intent,
      summary: candidate.summary,
      confidence: candidate.confidence,
      reviewStacks: [
        {
          id: "stack-1",
          title: "Delete control",
          explanation: "Sizing and action hooks must load before the delete button appears.",
          fileIds: [file.id],
          fileTree: { branches: [] },
        },
      ],
      files: materialized.files,
    };

    assert.deepEqual(
      materialized.files[0].sectionTree.sections[0].changedLineIds,
      importChangedLineIds,
    );
    validateReviewAnalysis(analysis, { inventory });
  });

  it("reports unknown hunk line boundaries during validation", () => {
    const inventory = createDiffInventory(importGapDiff);
    const file = inventory.files[0];
    const locations = indexHunkLineLocations(inventory);
    const errors = [];

    validateSectionChangedLineRanges({
      changedLineIds: ["file-1:hunk-1:line-4"],
      errors,
      file,
      inventoryFile: file,
      locations,
      owner: "file-1/imports",
      section: {
        id: "imports",
        changedLineRanges: [{ start: "file-1:hunk-1:line-4", end: "file-1:hunk-1:line-999" }],
      },
    });

    assert.match(errors[0], /unknown hunk line boundary/);
  });
});
