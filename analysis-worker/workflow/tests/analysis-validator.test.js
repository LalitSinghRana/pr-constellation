import assert from "node:assert/strict";
import { createDiffInventory } from "../03-build-diff-inventory/diff-inventory.js";
import {
  validateReviewAnalysis,
  validateReviewStacks,
} from "../05-validate-candidate/validate-analysis.js";

const inventory = createDiffInventory(`diff --git a/src/example.js b/src/example.js
index 0000000..1111111 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1,2 +1,3 @@
-const value = 1;
+const value = 2;
+validate(value);
 console.log(value);
diff --git a/src/example.test.js b/src/example.test.js
index 2222222..3333333 100644
--- a/src/example.test.js
+++ b/src/example.test.js
@@ -1 +1 @@
-expect(value).toBe(1);
+expect(value).toBe(2);
`);

const [runtimeFile, testFile] = inventory.files;
const validAnalysis = {
  schemaVersion: "pr-review-analysis/v1",
  intent: "Review the example value change",
  summary: "Update the runtime value and its expectation.",
  confidence: 1,
  files: [
    buildFile({
      file: runtimeFile,
      sections: [
        buildSection({
          changedLineIds: runtimeFile.changedLineIds.slice(0, 2),
          id: "change-runtime-value",
          title: "Change runtime value",
        }),
        buildSection({
          changedLineIds: runtimeFile.changedLineIds.slice(2),
          id: "validate-runtime-value",
          reviewPriority: "secondary",
          title: "Validate runtime value",
        }),
      ],
      branches: [branch("change-runtime-value", "validate-runtime-value")],
    }),
    buildFile({
      changeKind: "test",
      file: testFile,
      reviewPriority: "secondary",
      sections: [buildSection({
        changedLineIds: testFile.changedLineIds,
        changeKind: "test",
        id: "update-value-expectation",
        title: "Update value expectation",
      })],
    }),
  ],
  reviewStacks: [{
    id: "combined",
    title: "Runtime value and expectation",
    explanation: "The assertion follows the runtime behavior it verifies.",
    fileIds: [runtimeFile.id, testFile.id],
    fileTree: { branches: [branch(runtimeFile.id, testFile.id)] },
  }],
};

expectValid(validAnalysis);

const contextInventory = createDiffInventory(`diff --git a/src/context.js b/src/context.js
index 4444444..5555555 100644
--- a/src/context.js
+++ b/src/context.js
@@ -1,3 +1,3 @@
-const value = 1;
+const value = 2;
 keepContext();
-run(1);
+run(2);
`);
const [contextFile] = contextInventory.files;
expectValid({
  schemaVersion: "pr-review-analysis/v1",
  intent: "Keep one change together across context",
  summary: "The value and its use form one section.",
  confidence: 1,
  files: [buildFile({
    file: contextFile,
    sections: [buildSection({
      changedLineIds: contextFile.changedLineIds,
      id: "update-value-and-use",
      title: "Update value and use",
    })],
  })],
  reviewStacks: [{
    id: "context-change",
    title: "Context change",
    explanation: "One file owns the complete change.",
    fileIds: [contextFile.id],
    fileTree: { branches: [] },
  }],
}, contextInventory);

expectInvalid({
  analysis: { ...validAnalysis, schemaVersion: "invalid" },
  message: "invalid or missing schemaVersion",
  name: "invalid schema",
});

expectInvalid({
  analysis: { ...validAnalysis, files: validAnalysis.files.slice(0, 1) },
  message: "exactly one file for each changed file",
  name: "missing changed file",
});

expectInvalid({
  analysis: patchFile(validAnalysis, 0, { sectionTree: undefined }),
  message: "must contain exactly one sectionTree",
  name: "missing Section Tree",
});

expectInvalid({
  analysis: patchSection(validAnalysis, 0, 1, {
    changedLineIds: [runtimeFile.changedLineIds[0]],
    changedLineRanges: [range([runtimeFile.changedLineIds[0]])],
  }),
  message: "assigned to more than one review section",
  name: "duplicate changed-line ownership",
});

expectInvalid({
  analysis: patchFile(validAnalysis, 0, {
    changedLineIds: runtimeFile.changedLineIds.slice(0, 2),
  }),
  message: "file file-1 changedLineIds must exactly match",
  name: "incomplete file ownership",
});

expectInvalid({
  analysis: patchSectionTree(validAnalysis, 0, {
    branches: [branch("change-runtime-value", "missing-section")],
  }),
  message: "references unknown childId",
  name: "branch to unknown section",
});

expectInvalid({
  analysis: patchSectionTree(validAnalysis, 0, { branches: [] }),
  message: "must contain exactly one root; found 2",
  name: "disconnected Section Tree",
});

expectInvalid({
  analysis: patchSection(validAnalysis, 0, 0, { reviewPriority: "urgent" }),
  message: "must use reviewPriority primary, secondary, skim",
  name: "unknown review priority",
});

expectInvalid({
  analysis: patchSection(validAnalysis, 0, 1, {
    changedLineIds: [testFile.changedLineIds[0]],
    changedLineRanges: [range([testFile.changedLineIds[0]])],
  }),
  message: `uses changed line ${testFile.changedLineIds[0]} from ${testFile.path}`,
  name: "cross-file section ownership",
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    reviewStacks: [{
      ...validAnalysis.reviewStacks[0],
      fileTree: { branches: [branch(testFile.id, runtimeFile.id)] },
    }],
  },
  message: "root file-2 is outranked",
  name: "lower-priority File Tree root",
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    reviewStacks: [{
      ...validAnalysis.reviewStacks[0],
      fileIds: [runtimeFile.id],
      fileTree: { branches: [] },
    }],
  },
  message: "reviewStacks fileIds must exactly match",
  name: "Review Stack omits a changed file",
});

const validStacks = {
  schemaVersion: "pr-review-stacks/v1",
  reviewStacks: [
    {
      id: "runtime",
      title: "Runtime",
      explanation: "Runtime behavior.",
      fileIds: [runtimeFile.id],
    },
    {
      id: "tests",
      title: "Tests",
      explanation: "Verification.",
      fileIds: [testFile.id],
    },
  ],
};
validateReviewStacks(validStacks, { inventory });
assert.throws(
  () => validateReviewStacks({
    ...validStacks,
    reviewStacks: [
      validStacks.reviewStacks[0],
      { ...validStacks.reviewStacks[1], fileIds: [runtimeFile.id] },
    ],
  }, { inventory }),
  /contains duplicate id/,
);

console.log("analysis validator checks passed");

function buildFile({
  changeKind = "runtime",
  file,
  reviewPriority = "primary",
  sections,
  branches = [],
}) {
  return {
    id: file.id,
    path: file.path,
    reviewPriority,
    changeKind,
    explanation: `Review ${file.path}.`,
    changedLineIds: [...file.changedLineIds],
    sectionTree: { sections, branches },
  };
}

function buildSection({
  changedLineIds,
  changeKind = "runtime",
  id,
  reviewPriority = "primary",
  title,
}) {
  return {
    id,
    title,
    reviewPriority,
    changeKind,
    explanation: `Review ${title}.`,
    changedLineIds: [...changedLineIds],
    changedLineRanges: [range(changedLineIds)],
  };
}

function range(changedLineIds) {
  return { start: changedLineIds[0], end: changedLineIds.at(-1) };
}

function branch(parentId, childId, order = 0) {
  return {
    parentId,
    childId,
    order,
    explanation: `Review ${childId} after ${parentId}.`,
  };
}

function patchFile(analysis, fileIndex, patch) {
  const next = structuredClone(analysis);
  next.files[fileIndex] = { ...next.files[fileIndex], ...patch };
  return next;
}

function patchSectionTree(analysis, fileIndex, patch) {
  const next = structuredClone(analysis);
  next.files[fileIndex].sectionTree = {
    ...next.files[fileIndex].sectionTree,
    ...patch,
  };
  return next;
}

function patchSection(analysis, fileIndex, sectionIndex, patch) {
  const next = structuredClone(analysis);
  next.files[fileIndex].sectionTree.sections[sectionIndex] = {
    ...next.files[fileIndex].sectionTree.sections[sectionIndex],
    ...patch,
  };
  return next;
}

function expectValid(analysis, targetInventory = inventory) {
  validateReviewAnalysis(analysis, { inventory: targetInventory });
}

function expectInvalid({ analysis, message, name }) {
  assert.throws(
    () => validateReviewAnalysis(analysis, { inventory }),
    new RegExp(escapeRegExp(message)),
    name,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
