import { createDiffInventory } from "../03-build-diff-inventory/diff-inventory.js";
import {
  validateMiniTreeAnalysis,
  validateReviewStack,
} from "../05-validate-candidate/validate-analysis.js";

const diff = `diff --git a/src/example.js b/src/example.js
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
`;

const inventory = createDiffInventory(diff);
const changedFiles = inventory.files.filter((file) => file.changedLineIds.length > 0);
const [runtimeFile, testFile] = changedFiles;
const validAnalysis = {
  schemaVersion: "pr-graph-mini-trees/v2",
  intent: "Review the example value change",
  summary: "Update the runtime value and its expectation.",
  confidence: 1,
  files: [
    buildFile({
      file: runtimeFile,
      miniTree: {
        nodes: [
          miniNode({
            changedLineIds: runtimeFile.changedLineIds.slice(0, 2),
            changeRole: "runtime",
            id: "change-runtime-value",
            reviewClass: "important",
            title: "Change runtime value",
          }),
          miniNode({
            changedLineIds: runtimeFile.changedLineIds.slice(2),
            changeRole: "runtime",
            id: "validate-runtime-value",
            reviewClass: "supporting",
            title: "Validate runtime value",
          }),
        ],
        reviewEdges: [
          reviewEdge({
            from: "change-runtime-value",
            order: 0,
            to: "validate-runtime-value",
          }),
        ],
        relations: [
          relation({
            from: "validate-runtime-value",
            to: "change-runtime-value",
          }),
        ],
      },
    }),
    buildFile({
      changeRole: "test",
      file: testFile,
      miniTree: {
        nodes: [
          miniNode({
            changedLineIds: testFile.changedLineIds,
            changeRole: "test",
            id: "update-value-expectation",
            reviewClass: "important",
            title: "Update value expectation",
          }),
        ],
        reviewEdges: [],
        relations: [],
      },
      reviewClass: "supporting",
    }),
  ],
};

expectValid(validAnalysis);
expectValid(asLegacyV1(validAnalysis));

const contextGapInventory = createDiffInventory(`diff --git a/src/context-gap.js b/src/context-gap.js
index 4444444..5555555 100644
--- a/src/context-gap.js
+++ b/src/context-gap.js
@@ -1,3 +1,3 @@
-const value = 1;
+const value = 2;
 keepContext();
-run(1);
+run(2);
`);
const [contextGapFile] = contextGapInventory.files;
const contextGapAnalysis = {
  schemaVersion: "pr-graph-mini-trees/v2",
  intent: "Keep one semantic change together across unchanged context",
  summary: "The value update and its use remain one review unit.",
  confidence: 1,
  files: [
    buildFile({
      file: contextGapFile,
      miniTree: {
        nodes: [
          miniNode({
            changedLineIds: contextGapFile.changedLineIds,
            changeRole: "runtime",
            id: "update-value-and-use",
            reviewClass: "important",
            title: "Update value and use",
          }),
        ],
        reviewEdges: [],
        relations: [],
      },
    }),
  ],
};

expectValid(contextGapAnalysis, contextGapInventory);

const legacyWithInvalidDepth = asLegacyV1(validAnalysis);
legacyWithInvalidDepth.files[0].miniTree.nodes[1].depth = 3;
expectInvalid({
  analysis: legacyWithInvalidDepth,
  message: "must connect adjacent depths only",
  name: "legacy mini-tree with inconsistent depth",
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    schemaVersion: "pr-graph-analysis/v3",
  },
  message: "invalid or missing schemaVersion",
  name: "legacy hierarchy schema",
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    files: validAnalysis.files.slice(0, 1),
  },
  message: "exactly one file mini-tree for each changed file",
  name: "missing changed file mini-tree",
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    files: [...validAnalysis.files, structuredClone(validAnalysis.files[0])],
  },
  message: "more than one mini-tree for file id",
  name: "duplicate file mini-tree",
});

expectInvalid({
  analysis: patchFile(validAnalysis, 0, {
    miniTree: undefined,
  }),
  message: "must contain exactly one miniTree",
  name: "file without mini-tree",
});

expectInvalid({
  analysis: patchMiniNode(validAnalysis, 0, 1, {
    changedLineIds: [
      validAnalysis.files[0].miniTree.nodes[1].changedLineIds[0],
      validAnalysis.files[0].miniTree.nodes[0].changedLineIds[0],
    ],
  }),
  message: "assigned to more than one mini-tree node",
  name: "same changed line in two mini-nodes",
});

expectInvalid({
  analysis: patchMiniTree(validAnalysis, 0, {
    nodes: [
      {
        ...validAnalysis.files[0].miniTree.nodes[0],
        changedLineIds: [
          runtimeFile.changedLineIds[0],
          runtimeFile.changedLineIds[2],
        ],
      },
      {
        ...validAnalysis.files[0].miniTree.nodes[1],
        changedLineIds: [runtimeFile.changedLineIds[1]],
      },
    ],
  }),
  message: `cannot skip intervening changed line ${runtimeFile.changedLineIds[1]}`,
  name: "mini-node skips changed lines owned by another node",
});

expectInvalid({
  analysis: patchMiniTree(validAnalysis, 0, {
    nodes: [
      {
        ...validAnalysis.files[0].miniTree.nodes[0],
        changedLineIds: [
          runtimeFile.changedLineIds[1],
          runtimeFile.changedLineIds[0],
        ],
      },
      {
        ...validAnalysis.files[0].miniTree.nodes[1],
        changedLineIds: [runtimeFile.changedLineIds[2]],
      },
    ],
  }),
  message: "must appear in source order",
  name: "mini-node changed lines are not in source order",
});

expectInvalid({
  analysis: patchMiniNode(validAnalysis, 0, 1, {
    changedLineIds: [testFile.changedLineIds[0]],
  }),
  message: `uses changed line ${testFile.changedLineIds[0]} from ${testFile.path}`,
  name: "mini-tree contains another file's line",
});

expectInvalid({
  analysis: patchMiniNode(validAnalysis, 0, 0, {
    changedLineIds: validAnalysis.files[0].miniTree.nodes[0].changedLineIds.slice(0, 1),
  }),
  message: "miniTree changedLineIds must exactly match covered diff ids",
  name: "changed line omitted from mini-tree",
});

expectInvalid({
  analysis: patchFile(validAnalysis, 0, {
    codeRefs: {
      fileIds: [runtimeFile.id],
      changedLineIds: runtimeFile.changedLineIds.slice(0, -1),
    },
  }),
  message: "codeRefs.changedLineIds must exactly match covered diff ids",
  name: "file code refs omit a changed line",
});

expectInvalid({
  analysis: patchMiniTree(validAnalysis, 0, {
    reviewEdges: [],
  }),
  message: "must contain exactly one root with no incoming review edge",
  name: "disconnected mini-tree node",
});

expectValid(patchMiniTree(validAnalysis, 0, {
  reviewEdges: [
    reviewEdge({
      from: "validate-runtime-value",
      order: 0,
      to: "change-runtime-value",
    }),
  ],
}));

expectInvalid({
  analysis: patchMiniTree(validAnalysis, 0, {
    reviewEdges: [
      reviewEdge({
        from: "change-runtime-value",
        order: 1,
        to: "validate-runtime-value",
      }),
    ],
  }),
  message: "unique contiguous sibling order values starting at 0",
  name: "review hierarchy with non-contiguous sibling order",
});

expectInvalid({
  analysis: patchMiniTree(validAnalysis, 0, {
    relations: [
      relation({
        from: "validate-runtime-value",
        to: "missing-node",
      }),
    ],
  }),
  message: "relations references unknown to id",
  name: "technical relation to unknown mini-node",
});

expectValid(patchMiniNode(validAnalysis, 0, 0, {
  reviewClass: "important",
}));

expectValid(patchMiniNode(validAnalysis, 0, 1, {
  reviewClass: "mechanical",
}));

expectValid(patchMiniNode(validAnalysis, 0, 1, {
  changeRole: "imports",
  reviewClass: "supporting",
}));

expectValid(patchFile(validAnalysis, 0, {
  changeRole: "type",
  reviewClass: "important",
}));

expectValid(patchMiniNode(validAnalysis, 1, 0, {
  changeRole: "type",
  reviewClass: "supporting",
}));

expectInvalid({
  analysis: patchMiniNode(validAnalysis, 0, 0, {
    reviewClass: "urgent",
  }),
  message: "must use reviewClass",
  name: "mini-node with unknown review class value",
});

expectInvalid({
  analysis: patchMiniNode(validAnalysis, 0, 0, {
    changeRole: "behavior",
  }),
  message: "has invalid changeRole",
  name: "mini-node with unknown change role value",
});

expectInvalid({
  analysis: patchMiniNode(validAnalysis, 0, 0, {
    comment: "",
  }),
  message: "comment must be a non-empty string",
  name: "mini-node with an empty required comment value",
});

const longExplanationWithoutBullets = (
  "This explanation covers the changed responsibility, why the PR needs it, "
  + "the reviewer-facing consequence, and the contract that downstream work must preserve. "
).repeat(3).trim();

expectValid(patchMiniNode(validAnalysis, 0, 0, {
  comment: longExplanationWithoutBullets,
}));

expectValid(patchMiniTree(validAnalysis, 0, {
  reviewEdges: [{
    ...validAnalysis.files[0].miniTree.reviewEdges[0],
    comment: longExplanationWithoutBullets,
  }],
}));

expectValid(patchMiniNode(validAnalysis, 0, 0, {
  comment: `${longExplanationWithoutBullets}

- What: the runtime contract changes for every caller.
- Why: downstream validation must preserve the new behavior.`,
}));

function buildFile({
  changeRole = "runtime",
  file,
  miniTree,
  reviewClass = "important",
}) {
  return {
    id: file.id,
    path: file.path,
    reviewClass,
    changeRole,
    comment: `${file.path} contains one complete file-local review tree.`,
    codeRefs: {
      fileIds: [file.id],
      changedLineIds: file.changedLineIds,
    },
    miniTree,
  };
}

function miniNode({
  changedLineIds,
  changeRole,
  id,
  reviewClass,
  title,
}) {
  return {
    id,
    title,
    reviewClass,
    changeRole,
    comment: `${title} is a distinct file-local review concept.`,
    changedLineIds,
  };
}

function reviewEdge({ from, order, to }) {
  return {
    from,
    to,
    order,
    comment: `Review ${to} after ${from}.`,
  };
}

function relation({ from, to }) {
  return {
    from,
    to,
    relation: "depends on",
    comment: `${from} technically depends on ${to}.`,
  };
}

function patchFile(analysis, fileIndex, patch) {
  const next = structuredClone(analysis);
  next.files[fileIndex] = {
    ...next.files[fileIndex],
    ...patch,
  };
  return next;
}

function patchMiniNode(analysis, fileIndex, nodeIndex, patch) {
  const next = structuredClone(analysis);
  next.files[fileIndex].miniTree.nodes[nodeIndex] = {
    ...next.files[fileIndex].miniTree.nodes[nodeIndex],
    ...patch,
  };
  return next;
}

function patchMiniTree(analysis, fileIndex, patch) {
  const next = structuredClone(analysis);
  next.files[fileIndex].miniTree = {
    ...next.files[fileIndex].miniTree,
    ...patch,
  };
  return next;
}

function asLegacyV1(analysis) {
  const legacy = structuredClone(analysis);
  legacy.schemaVersion = "pr-graph-mini-trees/v1";

  for (const file of legacy.files) {
    const depthByNodeId = deriveDepths(file.miniTree);
    file.miniTree.nodes = file.miniTree.nodes.map((node) => ({
      ...node,
      depth: depthByNodeId.get(node.id),
    }));
    file.miniTree.edges = file.miniTree.reviewEdges.map((edgeValue) => ({
      from: edgeValue.from,
      to: edgeValue.to,
      relation: "requires",
      comment: edgeValue.comment,
    }));
    delete file.miniTree.reviewEdges;
    delete file.miniTree.relations;
  }

  return legacy;
}

function deriveDepths(miniTree) {
  const incomingIds = new Set(miniTree.reviewEdges.map((edge) => edge.to));
  const childrenById = new Map(miniTree.nodes.map((node) => [node.id, []]));
  for (const edge of miniTree.reviewEdges) {
    childrenById.get(edge.from)?.push(edge.to);
  }

  const root = miniTree.nodes.find((node) => !incomingIds.has(node.id));
  const depths = new Map();
  const queue = root ? [[root.id, 0]] : [];
  for (let index = 0; index < queue.length; index += 1) {
    const [nodeId, depth] = queue[index];
    depths.set(nodeId, depth);
    for (const childId of childrenById.get(nodeId) || []) {
      queue.push([childId, depth + 1]);
    }
  }
  return depths;
}

function expectValid(analysis, targetInventory = inventory, reviewStack = undefined) {
  validateMiniTreeAnalysis(analysis, { inventory: targetInventory, reviewStack });
}

function expectInvalid({ analysis, message, name, reviewStack = undefined }) {
  try {
    validateMiniTreeAnalysis(analysis, { inventory, reviewStack });
  } catch (error) {
    if (error.message.includes(message)) {
      return;
    }

    throw new Error(`Expected ${name} to fail with "${message}", got:\n${error.message}`);
  }

  throw new Error(`Expected ${name} to fail validation.`);
}

const validReviewStack = {
  schemaVersion: "pr-graph-review-stack/v1",
  stacks: [
    { id: "runtime-value", title: "Runtime value change", comment: "The core behavior change.", fileIds: [runtimeFile.id] },
    { id: "value-tests", title: "Value tests", comment: "Coverage for the runtime change.", fileIds: [testFile.id] },
  ],
};

expectReviewStackValid(validReviewStack);

expectReviewStackInvalid({
  message: "must exactly match covered diff ids",
  name: "review stack missing a changed file id",
  stack: {
    ...validReviewStack,
    stacks: [validReviewStack.stacks[0]],
  },
});

expectReviewStackInvalid({
  message: "contains duplicate id",
  name: "review stack with a duplicated file id",
  stack: {
    ...validReviewStack,
    stacks: [
      { ...validReviewStack.stacks[0], fileIds: [runtimeFile.id, testFile.id] },
      validReviewStack.stacks[1],
    ],
  },
});

expectReviewStackInvalid({
  message: "must be a non-empty string",
  name: "review stack with a missing comment",
  stack: {
    ...validReviewStack,
    stacks: [{ ...validReviewStack.stacks[0], comment: "" }, validReviewStack.stacks[1]],
  },
});

function expectReviewStackValid(stack, targetInventory = inventory) {
  validateReviewStack(stack, { inventory: targetInventory });
}

function expectReviewStackInvalid({ message, name, stack }) {
  try {
    validateReviewStack(stack, { inventory });
  } catch (error) {
    if (error.message.includes(message)) {
      return;
    }

    throw new Error(`Expected ${name} to fail with "${message}", got:\n${error.message}`);
  }

  throw new Error(`Expected ${name} to fail validation.`);
}

// fileFlow is the file-to-file review order within one review stack (layer-flow-middle-tree
// plan). runtimeFile is important/runtime and outranks testFile (supporting/test), so a
// stack containing both must root at runtimeFile.
const combinedReviewStack = {
  schemaVersion: "pr-graph-review-stack/v1",
  stacks: [{
    id: "combined",
    title: "Combined change",
    comment: "The runtime change and its test reviewed together.",
    fileIds: [runtimeFile.id, testFile.id],
  }],
};

expectValid(
  {
    ...validAnalysis,
    fileFlows: {
      combined: {
        edges: [{
          from: runtimeFile.id,
          to: testFile.id,
          order: 0,
          comment: "The test covers the runtime change.",
        }],
      },
    },
  },
  inventory,
  combinedReviewStack,
);

expectInvalid({
  analysis: {
    ...validAnalysis,
    fileFlows: {
      combined: {
        edges: [{
          from: runtimeFile.id,
          to: "file-outside-stack",
          order: 0,
          comment: "Points outside the stack.",
        }],
      },
    },
  },
  message: "references unknown to id",
  name: "file flow edge pointing outside its review stack",
  reviewStack: combinedReviewStack,
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    fileFlows: { combined: { edges: [] } },
  },
  message: "must contain exactly one root",
  name: "file flow with two roots",
  reviewStack: combinedReviewStack,
});

expectInvalid({
  analysis: {
    ...validAnalysis,
    files: [
      validAnalysis.files[0],
      { ...validAnalysis.files[1], reviewClass: "important", changeRole: "snapshot" },
    ],
    fileFlows: {
      combined: {
        edges: [{
          from: testFile.id,
          to: runtimeFile.id,
          order: 0,
          comment: "Reviewed the snapshot first.",
        }],
      },
    },
  },
  message: "is outranked by another file",
  name: "file flow root is a snapshot file while a runtime file is present",
  reviewStack: combinedReviewStack,
});

// Regression case for the tie bug: two files with identical reviewClass/changeRole (both
// important/runtime) must both be acceptable roots. The model's choice between them is a
// judgement call this validator cannot second-guess (see the plan's own PR 4919 data,
// where several stacks have 2-3 important files each).
expectValid(
  {
    ...validAnalysis,
    files: [
      validAnalysis.files[0],
      { ...validAnalysis.files[1], reviewClass: "important", changeRole: "runtime" },
    ],
    fileFlows: {
      combined: {
        edges: [{
          from: testFile.id,
          to: runtimeFile.id,
          order: 0,
          comment: "Reviewed this file's change first even though both are important/runtime.",
        }],
      },
    },
  },
  inventory,
  combinedReviewStack,
);
