const FILE_REVIEW_CLASSES = new Set(["important", "supporting", "mechanical"]);
const MINI_NODE_REVIEW_CLASSES = new Set(["core", ...FILE_REVIEW_CLASSES]);
const CHANGE_ROLES = new Set([
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
const MINI_TREE_SCHEMA_V1 = "pr-graph-mini-trees/v1";
const MINI_TREE_SCHEMA_V2 = "pr-graph-mini-trees/v2";
const MINI_TREE_SCHEMA_VERSIONS = new Set([MINI_TREE_SCHEMA_V1, MINI_TREE_SCHEMA_V2]);

export function validateMiniTreeAnalysis(analysis, { inventory = null } = {}) {
  const errors = [];

  if (!MINI_TREE_SCHEMA_VERSIONS.has(analysis?.schemaVersion)) {
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
    errors.push("analysis.json must contain at least one file mini-tree.");
  }

  if (errors.length > 0) {
    throwValidationError(errors);
  }

  validateFiles({ analysis, errors, inventory });

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

// Keep the established export name while the product contract is mini-tree-only.
export function validateGraphAnalysis(analysis, options = {}) {
  validateMiniTreeAnalysis(analysis, options);
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
      `analysis.json must contain exactly one file mini-tree for each changed file; expected ${inventoryChangedFiles.length}, found ${analysis.files.length}.`,
    );
  }

  for (const file of analysis.files) {
    if (!isNonEmptyString(file?.id)) {
      errors.push("analysis.json contains a file with a missing id.");
      continue;
    }

    if (analysisFileIds.has(file.id)) {
      errors.push(`analysis.json contains more than one mini-tree for file id: ${file.id}`);
      continue;
    }
    analysisFileIds.add(file.id);

    if (!isNonEmptyString(file.path)) {
      errors.push(`analysis.json file ${file.id} is missing path.`);
    } else if (analysisFilePaths.has(file.path)) {
      errors.push(`analysis.json contains more than one mini-tree for file path: ${file.path}`);
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
      errors.push(`analysis.json references file path that is not changed in diff-inventory.json: ${file.path}`);
    }

    validateReviewClassAndRoleValues({
      allowedReviewClasses: FILE_REVIEW_CLASSES,
      errors,
      targetId: `file ${file.id}`,
      value: file,
    });

    validateRequiredText({
      errors,
      label: `file ${file.id} comment`,
      value: file.comment,
    });

    if (!file.miniTree || typeof file.miniTree !== "object") {
      errors.push(`analysis.json file ${file.id} must contain exactly one miniTree.`);
      continue;
    }

    if (!Array.isArray(file.miniTree.nodes) || file.miniTree.nodes.length === 0) {
      errors.push(`analysis.json file ${file.id} miniTree must contain at least one node.`);
      continue;
    }

    if (analysis.schemaVersion === MINI_TREE_SCHEMA_V2) {
      if (!Array.isArray(file.miniTree.reviewEdges)) {
        errors.push(`analysis.json file ${file.id} miniTree.reviewEdges must be an array.`);
      }
      if (!Array.isArray(file.miniTree.relations)) {
        errors.push(`analysis.json file ${file.id} miniTree.relations must be an array.`);
      }
    } else if (!Array.isArray(file.miniTree.edges)) {
      errors.push(`analysis.json file ${file.id} miniTree.edges must be an array.`);
    }

    const coveredLineIds = validateMiniTree({
      analysisSchemaVersion: analysis.schemaVersion,
      changedLineOwnerById,
      errors,
      file,
      inventoryLineById,
      inventoryLinePositionById,
    });
    const expectedLineIds = inventoryFile?.changedLineIds || [...coveredLineIds];

    validateExactIdSet({
      actualIds: [...coveredLineIds],
      errors,
      expectedIds: expectedLineIds,
      label: `file ${file.id} miniTree changedLineIds`,
    });
    validateCodeRefs({
      errors,
      expectedFileIds: [file.id],
      expectedLineIds,
      targetId: `file ${file.id}`,
      value: file.codeRefs,
    });
  }

  if (!inventory) {
    return;
  }

  for (const inventoryFile of inventoryChangedFiles) {
    if (!analysisFileIds.has(inventoryFile.id)) {
      errors.push(`analysis.json is missing a mini-tree for changed file id: ${inventoryFile.id}`);
    }

    if (!analysisFilePaths.has(inventoryFile.path)) {
      errors.push(`analysis.json is missing a mini-tree for changed file path: ${inventoryFile.path}`);
    }
  }

  for (const changedLineId of inventoryLineById.keys()) {
    if (!changedLineOwnerById.has(changedLineId)) {
      errors.push(`analysis.json changed line id is not covered by any file miniTree node: ${changedLineId}`);
    }
  }
}

function validateMiniTree({
  analysisSchemaVersion,
  changedLineOwnerById,
  errors,
  file,
  inventoryLineById,
  inventoryLinePositionById,
}) {
  const miniNodeIds = new Set();
  const miniNodeById = new Map();
  const parentCounts = new Map();
  const childrenById = new Map();
  const fileChangedLineIds = new Set();

  for (const miniNode of file.miniTree.nodes) {
    if (!isNonEmptyString(miniNode?.id) || miniNodeIds.has(miniNode.id)) {
      errors.push(
        `analysis.json file ${file.id} contains a missing or duplicate miniTree node id: ${miniNode?.id || "<missing>"}`,
      );
      continue;
    }

    miniNodeIds.add(miniNode.id);
    miniNodeById.set(miniNode.id, miniNode);
    parentCounts.set(miniNode.id, 0);
    childrenById.set(miniNode.id, []);

    const owner = `${file.id}/${miniNode.id}`;
    validateReviewClassAndRoleValues({
      allowedReviewClasses: MINI_NODE_REVIEW_CLASSES,
      errors,
      targetId: `miniNode ${owner}`,
      value: miniNode,
    });

    if (!isNonEmptyString(miniNode.title)) {
      errors.push(`analysis.json miniNode ${owner} is missing title.`);
    }

    if (
      analysisSchemaVersion === MINI_TREE_SCHEMA_V1
      && (!Number.isInteger(miniNode.depth) || miniNode.depth < 0 || miniNode.depth > 6)
    ) {
      errors.push(`analysis.json miniNode ${owner} must have integer depth 0-6.`);
    }

    validateRequiredText({
      errors,
      label: `miniNode ${owner} comment`,
      value: miniNode.comment,
    });

    if (!Array.isArray(miniNode.changedLineIds) || miniNode.changedLineIds.length === 0) {
      errors.push(`analysis.json miniNode ${owner} must cover at least one changed line id.`);
      continue;
    }

    for (const changedLineId of miniNode.changedLineIds) {
      if (!isNonEmptyString(changedLineId)) {
        errors.push(`analysis.json miniNode ${owner} contains an invalid changed line id.`);
        continue;
      }

      const inventoryLine = inventoryLineById.get(changedLineId);
      if (inventoryLineById.size > 0 && !inventoryLine) {
        errors.push(`analysis.json miniNode ${owner} references unknown changed line id: ${changedLineId}`);
        continue;
      }

      if (inventoryLine?.file !== undefined && inventoryLine.file !== file.path) {
        errors.push(
          `analysis.json miniNode ${owner} uses changed line ${changedLineId} from ${inventoryLine.file}, but its mini-tree belongs to ${file.path}.`,
        );
        continue;
      }

      if (changedLineOwnerById.has(changedLineId)) {
        errors.push(
          `analysis.json changed line id ${changedLineId} is assigned to more than one mini-tree node: ${changedLineOwnerById.get(changedLineId)} and ${owner}.`,
        );
        continue;
      }

      changedLineOwnerById.set(changedLineId, owner);
      fileChangedLineIds.add(changedLineId);
    }

    validateChangedLineSequence({
      changedLineIds: miniNode.changedLineIds,
      errors,
      inventoryLinePositionById,
      owner,
    });
  }

  const usesReviewEdges = analysisSchemaVersion === MINI_TREE_SCHEMA_V2;
  const reviewEdges = usesReviewEdges
    ? file.miniTree.reviewEdges
    : file.miniTree.edges;

  validateTreeEdges({
    edgeLabel: `file ${file.id} miniTree.${usesReviewEdges ? "reviewEdges" : "edges"}`,
    edges: reviewEdges,
    errors,
    ordered: usesReviewEdges,
    nodeById: miniNodeById,
    nodeIds: miniNodeIds,
    parentCounts,
    childrenById,
    rootLabel: `file ${file.id} miniTree`,
  });
  if (usesReviewEdges) {
    validateTechnicalRelations({
      errors,
      nodeIds: miniNodeIds,
      relationLabel: `file ${file.id} miniTree.relations`,
      relations: file.miniTree.relations,
    });
  }
  return fileChangedLineIds;
}

function validateTreeEdges({
  edgeLabel,
  edges,
  errors,
  ordered,
  nodeById,
  nodeIds,
  parentCounts,
  childrenById,
  rootLabel,
}) {
  if (!Array.isArray(edges)) {
    return null;
  }

  const edgeIds = new Set();
  const ordersByParentId = new Map();

  for (const [index, edge] of edges.entries()) {
    if (!edge || typeof edge !== "object") {
      errors.push(`analysis.json ${edgeLabel} entry at index ${index} must be an object.`);
      continue;
    }

    const edgeId = `${edge.from || "<missing>"}->${edge.to || "<missing>"}`;
    if (edgeIds.has(edgeId)) {
      errors.push(`analysis.json ${edgeLabel} contains duplicate edge: ${edgeId}`);
      continue;
    }
    edgeIds.add(edgeId);

    if (!ordered && !isNonEmptyString(edge.relation)) {
      errors.push(`analysis.json ${edgeLabel} ${edgeId} is missing relation.`);
    }

    if (ordered) {
      if (!Number.isInteger(edge.order) || edge.order < 0) {
        errors.push(`analysis.json ${edgeLabel} ${edgeId} must have a non-negative integer order.`);
      } else {
        const orders = ordersByParentId.get(edge.from) || [];
        orders.push(edge.order);
        ordersByParentId.set(edge.from, orders);
      }
    }

    validateRequiredText({
      errors,
      label: `${edgeLabel} ${edgeId} comment`,
      value: edge.comment,
    });

    if (edge.from === edge.to) {
      errors.push(`analysis.json ${edgeLabel} ${edgeId} cannot point to itself.`);
      continue;
    }

    if (!nodeIds.has(edge.from)) {
      errors.push(`analysis.json ${edgeLabel} references unknown from id: ${edge.from}`);
    }

    if (!nodeIds.has(edge.to)) {
      errors.push(`analysis.json ${edgeLabel} references unknown to id: ${edge.to}`);
    }

    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode || !toNode) {
      continue;
    }

    if (!ordered && toNode.depth !== fromNode.depth + 1) {
      errors.push(
        `analysis.json ${edgeLabel} must connect adjacent depths only: ${edge.from} depth ${fromNode.depth} -> ${edge.to} depth ${toNode.depth}`,
      );
    }

    parentCounts.set(edge.to, (parentCounts.get(edge.to) || 0) + 1);
    childrenById.get(edge.from)?.push(edge.to);
  }

  if (ordered) {
    for (const [parentId, orders] of ordersByParentId) {
      const sortedOrders = orders.slice().sort((left, right) => left - right);
      const expectedOrders = sortedOrders.map((_, index) => index);

      if (
        sortedOrders.length !== new Set(sortedOrders).size
        || sortedOrders.some((order, index) => order !== expectedOrders[index])
      ) {
        errors.push(
          `analysis.json ${edgeLabel} from ${parentId} must use unique contiguous sibling order values starting at 0.`,
        );
      }
    }
  }

  const roots = [...nodeById.values()].filter((node) => {
    return (parentCounts.get(node.id) || 0) === 0;
  });
  if (roots.length !== 1) {
    errors.push(
      `analysis.json ${rootLabel} must contain exactly one root with no incoming review edge; found ${roots.length}.`,
    );
  }

  const rootNode = roots.length === 1 ? roots[0] : null;
  for (const node of nodeById.values()) {
    const parents = parentCounts.get(node.id) || 0;

    if (rootNode && node.id !== rootNode.id && parents !== 1) {
      errors.push(`analysis.json non-root miniNode must have exactly one parent: ${node.id} has ${parents}.`);
    }
  }

  if (rootNode) {
    if (!ordered && rootNode.depth !== 0) {
      errors.push(
        `analysis.json ${rootLabel} legacy root must use depth 0; ${rootNode.id} has depth ${rootNode.depth}.`,
      );
    }

    const reachable = collectReachableNodeIds(rootNode.id, childrenById);

    for (const node of nodeById.values()) {
      if (!reachable.has(node.id)) {
        errors.push(`analysis.json ${rootLabel} node is not reachable from its root: ${node.id}`);
      }
    }
  }

  return rootNode;
}

function validateTechnicalRelations({
  errors,
  nodeIds,
  relationLabel,
  relations,
}) {
  if (!Array.isArray(relations)) {
    return;
  }

  const relationIds = new Set();

  for (const [index, relation] of relations.entries()) {
    if (!relation || typeof relation !== "object") {
      errors.push(`analysis.json ${relationLabel} entry at index ${index} must be an object.`);
      continue;
    }

    const relationId = `${relation.from || "<missing>"}->${relation.to || "<missing>"}`;
    if (relationIds.has(relationId)) {
      errors.push(`analysis.json ${relationLabel} contains duplicate relation: ${relationId}`);
      continue;
    }
    relationIds.add(relationId);

    if (relation.from === relation.to) {
      errors.push(`analysis.json ${relationLabel} ${relationId} cannot point to itself.`);
    }
    if (!nodeIds.has(relation.from)) {
      errors.push(`analysis.json ${relationLabel} references unknown from id: ${relation.from}`);
    }
    if (!nodeIds.has(relation.to)) {
      errors.push(`analysis.json ${relationLabel} references unknown to id: ${relation.to}`);
    }
    if (!isNonEmptyString(relation.relation)) {
      errors.push(`analysis.json ${relationLabel} ${relationId} is missing relation.`);
    }
    validateRequiredText({
      errors,
      label: `${relationLabel} ${relationId} comment`,
      value: relation.comment,
    });
  }
}

function validateCodeRefs({ errors, expectedFileIds, expectedLineIds, targetId, value }) {
  if (!value || typeof value !== "object") {
    errors.push(`analysis.json ${targetId} is missing codeRefs.`);
    return;
  }

  if (!Array.isArray(value.fileIds)) {
    errors.push(`analysis.json ${targetId} codeRefs.fileIds must be an array.`);
  }

  if (!Array.isArray(value.changedLineIds)) {
    errors.push(`analysis.json ${targetId} codeRefs.changedLineIds must be an array.`);
  }

  const actualFileIds = Array.isArray(value.fileIds) ? value.fileIds : [];
  const actualLineIds = Array.isArray(value.changedLineIds) ? value.changedLineIds : [];

  validateNoDuplicates({ errors, ids: actualFileIds, label: `${targetId} codeRefs.fileIds` });
  validateNoDuplicates({
    errors,
    ids: actualLineIds,
    label: `${targetId} codeRefs.changedLineIds`,
  });
  validateExactIdSet({
    actualIds: actualFileIds,
    errors,
    expectedIds: expectedFileIds,
    label: `${targetId} codeRefs.fileIds`,
  });
  validateExactIdSet({
    actualIds: actualLineIds,
    errors,
    expectedIds: expectedLineIds,
    label: `${targetId} codeRefs.changedLineIds`,
  });
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
    ]
      .filter(Boolean)
      .join("; ");
    errors.push(
      `analysis.json ${label} must exactly match covered diff ids${details ? ` (${details})` : ""}.`,
    );
  }
}

function validateReviewClassAndRoleValues({
  allowedReviewClasses,
  errors,
  targetId,
  value,
}) {
  if (!allowedReviewClasses.has(value?.reviewClass)) {
    errors.push(
      `analysis.json ${targetId} must use reviewClass ${[...allowedReviewClasses].join(", ")}.`,
    );
  }

  if (!CHANGE_ROLES.has(value?.changeRole)) {
    errors.push(
      `analysis.json ${targetId} has invalid changeRole: ${value?.changeRole || "<missing>"}.`,
    );
  }
}

function validateRequiredText({ errors, label, value }) {
  if (!isNonEmptyString(value)) {
    errors.push(`analysis.json ${label} must be a non-empty string.`);
  }
}

function indexInventoryChangedLinePositions(inventory) {
  const positions = new Map();

  for (const file of inventory?.files || []) {
    for (const hunk of file.hunks || []) {
      let changedIndex = 0;

      for (const [lineIndex, line] of (hunk.lines || []).entries()) {
        if (line.kind !== "insert" && line.kind !== "delete") {
          continue;
        }

        positions.set(line.id, {
          file: file.path,
          hunkId: hunk.id,
          changedIndex,
          lineIndex,
        });
        changedIndex += 1;
      }
    }
  }

  return positions;
}

function validateChangedLineSequence({
  changedLineIds,
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

  if (positions.length !== changedLineIds.length || positions.length < 2) {
    return;
  }

  const hunkLocations = new Set(positions.map((entry) => {
    return `${entry.position.file}\0${entry.position.hunkId}`;
  }));
  if (hunkLocations.size !== 1) {
    errors.push(
      `analysis.json miniNode ${owner} changedLineIds must belong to one hunk; unchanged context gaps within that hunk are allowed.`,
    );
    return;
  }

  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];

    if (current.position.lineIndex <= previous.position.lineIndex) {
      errors.push(
        `analysis.json miniNode ${owner} changedLineIds must appear in source order; ${previous.changedLineId} is followed by ${current.changedLineId}.`,
      );
      return;
    }

    if (current.position.changedIndex !== previous.position.changedIndex + 1) {
      const skippedChangedLine = [...inventoryLinePositionById.entries()].find(
        ([, position]) => {
          return (
            position.file === previous.position.file
            && position.hunkId === previous.position.hunkId
            && position.changedIndex === previous.position.changedIndex + 1
          );
        },
      );

      errors.push(
        `analysis.json miniNode ${owner} changedLineIds may bridge context-only lines but cannot skip intervening changed line ${skippedChangedLine?.[0] || "<unknown>"}; ${previous.changedLineId} is followed by ${current.changedLineId}.`,
      );
      return;
    }
  }
}

function collectReachableNodeIds(rootId, childrenById) {
  const visited = new Set();
  const stack = [rootId];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);
    for (const childId of childrenById.get(nodeId) || []) {
      stack.push(childId);
    }
  }

  return visited;
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
