const REVIEW_ANALYSIS_SCHEMA_VERSION = "pr-review-analysis/v1";
const REVIEW_STACKS_SCHEMA_VERSION = "pr-review-stacks/v1";

const REVIEW_PRIORITIES = new Set(["primary", "secondary", "skim"]);
const CHANGE_KINDS = new Set([
  "runtime",
  "test",
  "storybook",
  "snapshot",
  "type",
  "docs",
  "config",
  "dependency",
  "generated",
  "formatting",
  "imports",
]);

// Keep these priorities aligned with the review UI's Stack Tree ordering.
const REVIEW_PRIORITY_ORDER = new Map([
  ["primary", 0],
  ["secondary", 1],
  ["skim", 2],
]);
const CHANGE_KIND_ORDER = new Map([
  ["runtime", 0],
  ["test", 1],
  ["storybook", 2],
  ["type", 3],
  ["config", 4],
  ["dependency", 5],
  ["docs", 6],
  ["snapshot", 7],
  ["generated", 8],
  ["formatting", 9],
  ["imports", 10],
]);

export function validateReviewAnalysis(analysis, { inventory = null } = {}) {
  const errors = [];

  if (analysis?.schemaVersion !== REVIEW_ANALYSIS_SCHEMA_VERSION) {
    errors.push("analysis.json has an invalid or missing schemaVersion.");
  }
  if (!isNonEmptyString(analysis?.intent)) {
    errors.push("analysis.json must include a non-empty intent.");
  }
  if (!isNonEmptyString(analysis?.summary)) {
    errors.push("analysis.json must include a non-empty summary.");
  }
  if (
    typeof analysis?.confidence !== "number"
    || !Number.isFinite(analysis.confidence)
    || analysis.confidence < 0
    || analysis.confidence > 1
  ) {
    errors.push("analysis.json confidence must be a number from 0 to 1.");
  }
  if (!Array.isArray(analysis?.files) || analysis.files.length === 0) {
    errors.push("analysis.json must contain at least one file.");
  }
  if (!Array.isArray(analysis?.reviewStacks) || analysis.reviewStacks.length === 0) {
    errors.push("analysis.json must contain at least one Review Stack.");
  }

  if (errors.length > 0) {
    throwValidationError(errors);
  }

  validateFiles({ analysis, errors, inventory });
  validateReviewStackEntries({
    errors,
    expectedFileIds: analysis.files.map((file) => file.id),
    label: "analysis.json reviewStacks",
    reviewStacks: analysis.reviewStacks,
    requireStackTree: true,
    fileById: new Map(analysis.files.map((file) => [file.id, file])),
  });

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

export function validateReviewStacks(document, { inventory = null } = {}) {
  const errors = [];

  if (document?.schemaVersion !== REVIEW_STACKS_SCHEMA_VERSION) {
    errors.push("review-stacks.json has an invalid or missing schemaVersion.");
  }
  if (!Array.isArray(document?.reviewStacks) || document.reviewStacks.length === 0) {
    errors.push("review-stacks.json must contain at least one Review Stack.");
  }
  if (errors.length > 0) {
    throwValidationError(errors);
  }

  const expectedFileIds = inventory
    ? (inventory.files || [])
      .filter((file) => Array.isArray(file.changedLineIds) && file.changedLineIds.length > 0)
      .map((file) => file.id)
    : null;

  validateReviewStackEntries({
    errors,
    expectedFileIds,
    label: "review-stacks.json reviewStacks",
    reviewStacks: document.reviewStacks,
    requireStackTree: false,
  });

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

function validateFiles({ analysis, errors, inventory }) {
  const inventoryChangedFiles = (inventory?.files || []).filter(
    (file) => Array.isArray(file.changedLineIds) && file.changedLineIds.length > 0,
  );
  const inventoryFileById = new Map(inventoryChangedFiles.map((file) => [file.id, file]));
  const inventoryFileByPath = new Map(inventoryChangedFiles.map((file) => [file.path, file]));
  const inventoryLineById = new Map((inventory?.changedLines || []).map((line) => [line.id, line]));
  const inventoryLinePositionById = indexInventoryChangedLinePositions(inventory);
  const analysisFileIds = new Set();
  const analysisFilePaths = new Set();
  const changedLineOwnerById = new Map();

  if (inventory && analysis.files.length !== inventoryChangedFiles.length) {
    errors.push(
      `analysis.json must contain exactly one file for each changed file; expected ${inventoryChangedFiles.length}, found ${analysis.files.length}.`,
    );
  }

  for (const file of analysis.files) {
    if (!isNonEmptyString(file?.id)) {
      errors.push("analysis.json contains a file with a missing id.");
      continue;
    }
    if (analysisFileIds.has(file.id)) {
      errors.push(`analysis.json contains more than one file with id: ${file.id}`);
      continue;
    }
    analysisFileIds.add(file.id);

    if (!isNonEmptyString(file.path)) {
      errors.push(`analysis.json file ${file.id} is missing path.`);
    } else if (analysisFilePaths.has(file.path)) {
      errors.push(`analysis.json contains more than one file with path: ${file.path}`);
    } else {
      analysisFilePaths.add(file.path);
    }

    const inventoryFile = inventoryFileById.get(file.id);
    if (inventory && !inventoryFile) {
      errors.push(`analysis.json file ${file.id} does not use a changed diff-inventory file id.`);
    } else if (inventoryFile?.path !== file.path) {
      errors.push(
        `analysis.json file ${file.id} path must match diff-inventory path ${inventoryFile.path}; got ${file.path}.`,
      );
    }
    if (inventory && isNonEmptyString(file.path) && !inventoryFileByPath.has(file.path)) {
      errors.push(`analysis.json references a path not changed in diff-inventory.json: ${file.path}`);
    }

    validateClassification({ errors, targetId: `file ${file.id}`, value: file });
    validateRequiredText({ errors, label: `file ${file.id} explanation`, value: file.explanation });

    if (!file.fileTree || typeof file.fileTree !== "object") {
      errors.push(`analysis.json file ${file.id} must contain exactly one fileTree.`);
      continue;
    }
    if (!Array.isArray(file.fileTree.sections) || file.fileTree.sections.length === 0) {
      errors.push(`analysis.json file ${file.id} fileTree must contain at least one section.`);
      continue;
    }
    if (!Array.isArray(file.fileTree.branches)) {
      errors.push(`analysis.json file ${file.id} fileTree.branches must be an array.`);
    }

    const coveredLineIds = validateFileTree({
      changedLineOwnerById,
      errors,
      file,
      inventoryLineById,
      inventoryLinePositionById,
    });
    const expectedLineIds = inventoryFile?.changedLineIds || [...coveredLineIds];

    if (!Array.isArray(file.changedLineIds)) {
      errors.push(`analysis.json file ${file.id} changedLineIds must be an array.`);
    } else {
      validateNoDuplicates({
        errors,
        ids: file.changedLineIds,
        label: `file ${file.id} changedLineIds`,
      });
      validateExactIdSet({
        actualIds: file.changedLineIds,
        errors,
        expectedIds: expectedLineIds,
        label: `file ${file.id} changedLineIds`,
      });
    }
    validateExactIdSet({
      actualIds: [...coveredLineIds],
      errors,
      expectedIds: expectedLineIds,
      label: `file ${file.id} fileTree changedLineIds`,
    });
  }

  if (!inventory) {
    return;
  }

  for (const inventoryFile of inventoryChangedFiles) {
    if (!analysisFileIds.has(inventoryFile.id)) {
      errors.push(`analysis.json is missing changed file id: ${inventoryFile.id}`);
    }
    if (!analysisFilePaths.has(inventoryFile.path)) {
      errors.push(`analysis.json is missing changed file path: ${inventoryFile.path}`);
    }
  }
  for (const changedLineId of inventoryLineById.keys()) {
    if (!changedLineOwnerById.has(changedLineId)) {
      errors.push(`analysis.json changed line id is not covered by any review section: ${changedLineId}`);
    }
  }
}

function validateFileTree({
  changedLineOwnerById,
  errors,
  file,
  inventoryLineById,
  inventoryLinePositionById,
}) {
  const sectionIds = new Set();
  const sectionById = new Map();
  const parentCounts = new Map();
  const childrenById = new Map();
  const fileChangedLineIds = new Set();

  for (const section of file.fileTree.sections) {
    if (!isNonEmptyString(section?.id) || sectionIds.has(section.id)) {
      errors.push(
        `analysis.json file ${file.id} contains a missing or duplicate review section id: ${section?.id || "<missing>"}`,
      );
      continue;
    }

    sectionIds.add(section.id);
    sectionById.set(section.id, section);
    parentCounts.set(section.id, 0);
    childrenById.set(section.id, []);

    const owner = `${file.id}/${section.id}`;
    validateClassification({ errors, targetId: `review section ${owner}`, value: section });
    validateRequiredText({ errors, label: `review section ${owner} title`, value: section.title });
    validateRequiredText({
      errors,
      label: `review section ${owner} explanation`,
      value: section.explanation,
    });

    if (!Array.isArray(section.changedLineIds) || section.changedLineIds.length === 0) {
      errors.push(`analysis.json review section ${owner} must cover at least one changed line id.`);
      continue;
    }
    validateNoDuplicates({
      errors,
      ids: section.changedLineIds,
      label: `review section ${owner} changedLineIds`,
    });

    for (const changedLineId of section.changedLineIds) {
      if (!isNonEmptyString(changedLineId)) {
        errors.push(`analysis.json review section ${owner} contains an invalid changed line id.`);
        continue;
      }

      const inventoryLine = inventoryLineById.get(changedLineId);
      if (inventoryLineById.size > 0 && !inventoryLine) {
        errors.push(`analysis.json review section ${owner} references unknown changed line id: ${changedLineId}`);
        continue;
      }
      if (inventoryLine?.file !== undefined && inventoryLine.file !== file.path) {
        errors.push(
          `analysis.json review section ${owner} uses changed line ${changedLineId} from ${inventoryLine.file}, but its file tree belongs to ${file.path}.`,
        );
        continue;
      }
      if (changedLineOwnerById.has(changedLineId)) {
        errors.push(
          `analysis.json changed line id ${changedLineId} is assigned to more than one review section: ${changedLineOwnerById.get(changedLineId)} and ${owner}.`,
        );
        continue;
      }

      changedLineOwnerById.set(changedLineId, owner);
      fileChangedLineIds.add(changedLineId);
    }

    validateChangedLineSequence({
      changedLineIds: section.changedLineIds,
      changedLineRanges: section.changedLineRanges,
      errors,
      inventoryLinePositionById,
      owner,
    });
  }

  validateTreeBranches({
    branchLabel: `file ${file.id} fileTree.branches`,
    branches: file.fileTree.branches,
    errors,
    itemById: sectionById,
    itemIds: sectionIds,
    parentCounts,
    childrenById,
    rootLabel: `file ${file.id} fileTree`,
    itemLabel: "review section",
  });

  return fileChangedLineIds;
}

function validateReviewStackEntries({
  errors,
  expectedFileIds,
  fileById = null,
  label,
  requireStackTree,
  reviewStacks,
}) {
  const stackIds = [];
  const allFileIds = [];

  for (const [index, stack] of reviewStacks.entries()) {
    const stackLabel = `${label}[${index}]`;
    if (!isNonEmptyString(stack?.id)) {
      errors.push(`${stackLabel} is missing id.`);
    } else {
      stackIds.push(stack.id);
    }
    validateRequiredText({ errors, label: `${stackLabel} title`, value: stack?.title });
    validateRequiredText({ errors, label: `${stackLabel} explanation`, value: stack?.explanation });

    if (!Array.isArray(stack?.fileIds) || stack.fileIds.length === 0) {
      errors.push(`${stackLabel} must contain at least one file id.`);
      continue;
    }
    validateNoDuplicates({ errors, ids: stack.fileIds, label: `${stackLabel} fileIds` });
    allFileIds.push(...stack.fileIds);

    if (!requireStackTree) {
      continue;
    }
    if (!stack.stackTree || typeof stack.stackTree !== "object") {
      errors.push(`${stackLabel} must contain a stackTree.`);
      continue;
    }
    if (!Array.isArray(stack.stackTree.branches)) {
      errors.push(`${stackLabel} stackTree.branches must be an array.`);
      continue;
    }

    const stackFiles = stack.fileIds.map((fileId) => fileById?.get(fileId)).filter(Boolean);
    const itemById = new Map(stackFiles.map((file) => [file.id, file]));
    const itemIds = new Set(stack.fileIds);
    const parentCounts = new Map(stack.fileIds.map((fileId) => [fileId, 0]));
    const childrenById = new Map(stack.fileIds.map((fileId) => [fileId, []]));
    const rootFile = validateTreeBranches({
      branchLabel: `${stackLabel} stackTree.branches`,
      branches: stack.stackTree.branches,
      errors,
      itemById,
      itemIds,
      parentCounts,
      childrenById,
      rootLabel: `${stackLabel} stackTree`,
      itemLabel: "file",
    });

    if (rootFile && !isAcceptableStackTreeRoot(rootFile, stackFiles)) {
      errors.push(
        `${stackLabel} stackTree root ${rootFile.id} is outranked by another file; the root must be tied for the best reviewPriority/changeKind tier.`,
      );
    }
  }

  validateNoDuplicates({ errors, ids: stackIds, label: `${label} ids` });
  validateNoDuplicates({ errors, ids: allFileIds, label: `${label} fileIds` });
  if (expectedFileIds) {
    validateExactIdSet({
      actualIds: allFileIds,
      errors,
      expectedIds: expectedFileIds,
      label: `${label} fileIds`,
    });
  }
}

function validateTreeBranches({
  branchLabel,
  branches,
  errors,
  itemById,
  itemIds,
  parentCounts,
  childrenById,
  rootLabel,
  itemLabel,
}) {
  if (!Array.isArray(branches)) {
    return null;
  }

  const branchIds = new Set();
  const ordersByParentId = new Map();

  for (const [index, branch] of branches.entries()) {
    if (!branch || typeof branch !== "object") {
      errors.push(`analysis.json ${branchLabel} entry at index ${index} must be an object.`);
      continue;
    }

    const branchId = `${branch.parentId || "<missing>"}->${branch.childId || "<missing>"}`;
    if (branchIds.has(branchId)) {
      errors.push(`analysis.json ${branchLabel} contains duplicate branch: ${branchId}`);
      continue;
    }
    branchIds.add(branchId);

    if (!Number.isInteger(branch.order) || branch.order < 0) {
      errors.push(`analysis.json ${branchLabel} ${branchId} must have a non-negative integer order.`);
    } else {
      const orders = ordersByParentId.get(branch.parentId) || [];
      orders.push(branch.order);
      ordersByParentId.set(branch.parentId, orders);
    }
    validateRequiredText({
      errors,
      label: `${branchLabel} ${branchId} explanation`,
      value: branch.explanation,
    });

    if (branch.parentId === branch.childId) {
      errors.push(`analysis.json ${branchLabel} ${branchId} cannot point to itself.`);
      continue;
    }
    if (!itemIds.has(branch.parentId)) {
      errors.push(`analysis.json ${branchLabel} references unknown parentId: ${branch.parentId}`);
    }
    if (!itemIds.has(branch.childId)) {
      errors.push(`analysis.json ${branchLabel} references unknown childId: ${branch.childId}`);
    }
    if (!itemById.has(branch.parentId) || !itemById.has(branch.childId)) {
      continue;
    }

    parentCounts.set(branch.childId, (parentCounts.get(branch.childId) || 0) + 1);
    childrenById.get(branch.parentId)?.push(branch.childId);
  }

  for (const [parentId, orders] of ordersByParentId) {
    const sortedOrders = orders.slice().sort((left, right) => left - right);
    if (
      sortedOrders.length !== new Set(sortedOrders).size
      || sortedOrders.some((order, index) => order !== index)
    ) {
      errors.push(
        `analysis.json ${branchLabel} from ${parentId} must use unique contiguous sibling order values starting at 0.`,
      );
    }
  }

  const roots = [...itemById.values()].filter((item) => (parentCounts.get(item.id) || 0) === 0);
  if (roots.length !== 1) {
    errors.push(`analysis.json ${rootLabel} must contain exactly one root; found ${roots.length}.`);
  }

  const root = roots.length === 1 ? roots[0] : null;
  for (const item of itemById.values()) {
    const parents = parentCounts.get(item.id) || 0;
    if (root && item.id !== root.id && parents !== 1) {
      errors.push(`analysis.json non-root ${itemLabel} must have exactly one parent: ${item.id} has ${parents}.`);
    }
  }

  if (root) {
    const reachable = collectReachableIds(root.id, childrenById);
    for (const item of itemById.values()) {
      if (!reachable.has(item.id)) {
        errors.push(`analysis.json ${rootLabel} ${itemLabel} is not reachable from its root: ${item.id}`);
      }
    }
  }

  return root;
}

export function isAcceptableStackTreeRoot(rootFile, files) {
  return !files.some((file) => (
    file.id !== rootFile.id
    && isStrictlyHigherPriority(file, rootFile)
  ));
}

function isStrictlyHigherPriority(file, otherFile) {
  const reviewPriorityDifference = (
    reviewPriorityOrder(file.reviewPriority) - reviewPriorityOrder(otherFile.reviewPriority)
  );
  if (reviewPriorityDifference !== 0) {
    return reviewPriorityDifference < 0;
  }
  return changeKindOrder(file.changeKind) < changeKindOrder(otherFile.changeKind);
}

function reviewPriorityOrder(reviewPriority) {
  return REVIEW_PRIORITY_ORDER.get(reviewPriority) ?? REVIEW_PRIORITY_ORDER.size;
}

function changeKindOrder(changeKind) {
  return CHANGE_KIND_ORDER.get(changeKind) ?? CHANGE_KIND_ORDER.size;
}

function validateClassification({ errors, targetId, value }) {
  if (!REVIEW_PRIORITIES.has(value?.reviewPriority)) {
    errors.push(
      `analysis.json ${targetId} must use reviewPriority ${[...REVIEW_PRIORITIES].join(", ")}.`,
    );
  }
  if (!CHANGE_KINDS.has(value?.changeKind)) {
    errors.push(
      `analysis.json ${targetId} has invalid changeKind: ${value?.changeKind || "<missing>"}.`,
    );
  }
}

function validateRequiredText({ errors, label, value }) {
  if (!isNonEmptyString(value)) {
    errors.push(`analysis.json ${label} must be a non-empty string.`);
  }
}

function validateNoDuplicates({ errors, ids, label }) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push(`analysis.json ${label} contains duplicate id: ${id}`);
    }
    seen.add(id);
  }
}

function validateExactIdSet({ actualIds, errors, expectedIds, label }) {
  const actual = new Set(actualIds);
  const expected = new Set(expectedIds);
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));

  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.slice(0, 5).join(", ")}` : "",
      extra.length > 0 ? `extra ${extra.slice(0, 5).join(", ")}` : "",
    ].filter(Boolean).join("; ");
    errors.push(
      `analysis.json ${label} must exactly match covered diff ids${details ? ` (${details})` : ""}.`,
    );
  }
}

function indexInventoryChangedLinePositions(inventory) {
  const positions = new Map();

  for (const [fileIndex, file] of (inventory?.files || []).entries()) {
    let fileChangedIndex = 0;
    for (const [hunkIndex, hunk] of (file.hunks || []).entries()) {
      let changedIndex = 0;

      for (const [lineIndex, line] of (hunk.lines || []).entries()) {
        if (line.kind !== "insert" && line.kind !== "delete") {
          continue;
        }

        positions.set(line.id, {
          file: file.path,
          fileChangedIndex,
          fileIndex,
          hunkId: hunk.id,
          hunkIndex,
          changedIndex,
          lineIndex,
        });
        changedIndex += 1;
        fileChangedIndex += 1;
      }
    }
  }

  return positions;
}

function validateChangedLineSequence({
  changedLineIds,
  changedLineRanges,
  errors,
  inventoryLinePositionById,
  owner,
}) {
  if (!Array.isArray(changedLineIds) || inventoryLinePositionById.size === 0) {
    return;
  }

  const positions = changedLineIds
    .map((changedLineId) => ({
      changedLineId,
      position: inventoryLinePositionById.get(changedLineId),
    }))
    .filter((entry) => entry.position);

  if (positions.length !== changedLineIds.length) {
    return;
  }

  if (Array.isArray(changedLineRanges)) {
    validateChangedLineRanges({
      changedLineIds,
      changedLineRanges,
      errors,
      inventoryLinePositionById,
      owner,
    });
    return;
  }

  if (positions.length < 2) {
    return;
  }

  const hunkLocations = new Set(positions.map((entry) => {
    return `${entry.position.file}\0${entry.position.hunkId}`;
  }));
  if (hunkLocations.size !== 1) {
    errors.push(
      `analysis.json review section ${owner} changedLineIds must belong to one hunk; unchanged context gaps within that hunk are allowed.`,
    );
    return;
  }

  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];

    if (current.position.lineIndex <= previous.position.lineIndex) {
      errors.push(
        `analysis.json review section ${owner} changedLineIds must appear in source order; ${previous.changedLineId} is followed by ${current.changedLineId}.`,
      );
      return;
    }

    if (current.position.changedIndex !== previous.position.changedIndex + 1) {
      const skippedChangedLine = [...inventoryLinePositionById.entries()].find(
        ([, position]) => (
          position.file === previous.position.file
          && position.hunkId === previous.position.hunkId
          && position.changedIndex === previous.position.changedIndex + 1
        ),
      );

      errors.push(
        `analysis.json review section ${owner} changedLineIds may bridge context-only lines but cannot skip intervening changed line ${skippedChangedLine?.[0] || "<unknown>"}; ${previous.changedLineId} is followed by ${current.changedLineId}.`,
      );
      return;
    }
  }
}

function validateChangedLineRanges({
  changedLineIds,
  changedLineRanges,
  errors,
  inventoryLinePositionById,
  owner,
}) {
  if (changedLineRanges.length === 0) {
    errors.push(`analysis.json review section ${owner} must contain at least one changedLineRange.`);
    return;
  }

  const expandedIds = [];
  let previousEndPosition = null;

  for (const [rangeIndex, range] of changedLineRanges.entries()) {
    const start = inventoryLinePositionById.get(range?.start);
    const end = inventoryLinePositionById.get(range?.end);

    if (!start || !end) {
      errors.push(
        `analysis.json review section ${owner} changedLineRanges[${rangeIndex}] references an unknown boundary.`,
      );
      continue;
    }
    if (
      start.file !== end.file
      || start.hunkId !== end.hunkId
      || start.changedIndex > end.changedIndex
    ) {
      errors.push(
        `analysis.json review section ${owner} changedLineRanges[${rangeIndex}] must be forward and stay within one file hunk.`,
      );
      continue;
    }
    if (
      previousEndPosition
      && (
        start.fileIndex < previousEndPosition.fileIndex
        || (
          start.fileIndex === previousEndPosition.fileIndex
          && start.fileChangedIndex <= previousEndPosition.fileChangedIndex
        )
      )
    ) {
      errors.push(
        `analysis.json review section ${owner} changedLineRanges must be non-overlapping and appear in source order.`,
      );
      continue;
    }

    const rangeIds = [...inventoryLinePositionById.entries()]
      .filter(([, position]) => (
        position.file === start.file
        && position.hunkId === start.hunkId
        && position.changedIndex >= start.changedIndex
        && position.changedIndex <= end.changedIndex
      ))
      .sort((left, right) => left[1].changedIndex - right[1].changedIndex)
      .map(([lineId]) => lineId);
    expandedIds.push(...rangeIds);
    previousEndPosition = end;
  }

  if (
    expandedIds.length !== changedLineIds.length
    || expandedIds.some((lineId, index) => lineId !== changedLineIds[index])
  ) {
    errors.push(
      `analysis.json review section ${owner} changedLineIds must exactly match its materialized changedLineRanges.`,
    );
  }
}

function collectReachableIds(rootId, childrenById) {
  const visited = new Set();
  const pending = [rootId];

  while (pending.length > 0) {
    const itemId = pending.pop();
    if (visited.has(itemId)) {
      continue;
    }
    visited.add(itemId);
    pending.push(...(childrenById.get(itemId) || []));
  }

  return visited;
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
