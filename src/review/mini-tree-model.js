// Pure mini-tree normalization and folding for generated review pages.
const ALWAYS_VISIBLE_REVIEW_CLASS = "core";
const ALWAYS_VISIBLE_RUNTIME_CLASS = "important";

export function normalizeMiniTree(file) {
  const miniTree = file?.miniTree || {};
  const nodes = miniTree.nodes || file?.miniNodes || [];
  const rawReviewEdges = miniTree.reviewEdges || miniTree.edges || file?.miniEdges || [];
  const nextOrderByParentId = new Map();
  const reviewEdges = rawReviewEdges.map((edge) => {
    const fallbackOrder = nextOrderByParentId.get(edge.from) || 0;
    const order = Number.isInteger(edge.order) ? edge.order : fallbackOrder;
    nextOrderByParentId.set(edge.from, Math.max(fallbackOrder, order) + 1);

    return {
      ...edge,
      order,
    };
  });

  return {
    nodes,
    relations: miniTree.relations || [],
    reviewEdges,
  };
}

export function foldMiniTree(file, { expandedGroupIds = [] } = {}) {
  const miniTree = normalizeMiniTree(file);
  const expandedIds = expandedGroupIds instanceof Set
    ? expandedGroupIds
    : new Set(expandedGroupIds);
  const nodeById = new Map(miniTree.nodes.map((node) => [node.id, node]));
  const nodeOrderById = new Map(miniTree.nodes.map((node, order) => [node.id, order]));
  const childrenById = new Map(miniTree.nodes.map((node) => [node.id, []]));
  const incomingIds = new Set();

  for (const edge of miniTree.reviewEdges) {
    if (
      edge.from === edge.to
      || !nodeById.has(edge.from)
      || !nodeById.has(edge.to)
      || incomingIds.has(edge.to)
    ) {
      continue;
    }

    childrenById.get(edge.from).push({
      edge,
      nodeId: edge.to,
    });
    incomingIds.add(edge.to);
  }

  for (const children of childrenById.values()) {
    children.sort((left, right) => {
      return (
        left.edge.order - right.edge.order
        || (nodeOrderById.get(left.nodeId) || 0) - (nodeOrderById.get(right.nodeId) || 0)
      );
    });
  }

  const roots = miniTree.nodes
    .filter((node) => !incomingIds.has(node.id))
    .sort((left, right) => {
      return (nodeOrderById.get(left.id) || 0) - (nodeOrderById.get(right.id) || 0);
    });
  const visibleNodes = [];
  const visibleReviewEdges = [];
  const visibleNodeIds = new Set();
  const groupIds = [];
  const subtreeVisibilityMemo = new Map();

  function subtreeContainsAlwaysVisible(nodeId, ancestry = new Set()) {
    if (subtreeVisibilityMemo.has(nodeId)) {
      return subtreeVisibilityMemo.get(nodeId);
    }
    if (ancestry.has(nodeId)) {
      return false;
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeId);
    const node = nodeById.get(nodeId);
    const containsVisible = isAlwaysVisibleMiniNode(node)
      || (childrenById.get(nodeId) || []).some((child) => {
        return subtreeContainsAlwaysVisible(child.nodeId, nextAncestry);
      });

    subtreeVisibilityMemo.set(nodeId, containsVisible);
    return containsVisible;
  }

  function addVisibleNode(node) {
    if (visibleNodeIds.has(node.id)) {
      return;
    }

    visibleNodeIds.add(node.id);
    visibleNodes.push(node);
  }

  function visit(nodeId, revealedBucketIds = new Set(), ancestry = new Set()) {
    if (ancestry.has(nodeId)) {
      return;
    }

    const node = nodeById.get(nodeId);
    if (!node) {
      return;
    }

    addVisibleNode(node);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeId);
    const directChildren = [];
    const foldedByBucketId = new Map();

    for (const child of childrenById.get(nodeId) || []) {
      const childNode = nodeById.get(child.nodeId);
      const bucket = collapseBucketForNode(childNode);
      const staysVisible = (
        !bucket
        || revealedBucketIds.has(bucket.id)
        || subtreeContainsAlwaysVisible(child.nodeId)
      );

      if (staysVisible) {
        directChildren.push(child);
        continue;
      }

      const group = foldedByBucketId.get(bucket.id) || {
        bucket,
        children: [],
        firstOrder: child.edge.order,
      };
      group.children.push(child);
      group.firstOrder = Math.min(group.firstOrder, child.edge.order);
      foldedByBucketId.set(bucket.id, group);
    }

    const childEntries = [
      ...directChildren.map((child) => ({
        kind: "node",
        order: child.edge.order,
        value: child,
      })),
      ...[...foldedByBucketId.values()].map((group) => ({
        kind: "group",
        order: group.firstOrder,
        value: group,
      })),
    ].sort((left, right) => left.order - right.order);

    for (const childEntry of childEntries) {
      if (childEntry.kind === "node") {
        const child = childEntry.value;
        visibleReviewEdges.push(child.edge);
        visit(child.nodeId, revealedBucketIds, nextAncestry);
        continue;
      }

      const { bucket, children } = childEntry.value;
      const groupNodeId = `ui-fold-${nodeId}-${bucket.id}`;
      const groupId = `${file.id}:${groupNodeId}`;
      const expanded = expandedIds.has(groupId);
      const forestNodeIds = collectForestNodeIds({
        childrenById,
        rootIds: children.map((child) => child.nodeId),
      });
      const forestNodes = forestNodeIds
        .map((forestNodeId) => nodeById.get(forestNodeId))
        .filter(Boolean);
      const lineCount = forestNodes.reduce((total, forestNode) => {
        return total + (forestNode.changedLineIds || []).length;
      }, 0);
      const groupNode = {
        id: groupNodeId,
        title: bucket.label,
        reviewClass: bucket.reviewClass,
        changeRole: bucket.changeRole,
        comment: `${bucket.label} groups lower-priority changes that support "${node.title}".\n\n- What: ${children.length} related review ${pluralize("subtree", children.length)} covering ${forestNodes.length} nodes.\n- Why: They share the same review priority and role, so the reviewer can inspect them together after the parent question.`,
        changedLineIds: [],
        collapsedGroup: {
          bucketId: bucket.id,
          expanded,
          groupId,
          lineCount,
          nodeCount: forestNodes.length,
          rootNodeIds: children.map((child) => child.nodeId),
          rootTitles: children
            .map((child) => nodeById.get(child.nodeId)?.title)
            .filter(Boolean),
          subtreeCount: children.length,
        },
      };

      groupIds.push(groupId);
      addVisibleNode(groupNode);
      visibleReviewEdges.push({
        from: nodeId,
        to: groupNodeId,
        order: childEntry.order,
        comment: `${bucket.label} follows "${node.title}" because these lower-priority changes support that parent question without replacing its primary review focus.`,
        synthetic: true,
      });

      if (!expanded) {
        continue;
      }

      const nextRevealedBucketIds = new Set(revealedBucketIds);
      nextRevealedBucketIds.add(bucket.id);

      children.forEach((child, order) => {
        const childTitle = nodeById.get(child.nodeId)?.title || child.nodeId;
        visibleReviewEdges.push({
          from: groupNodeId,
          to: child.nodeId,
          order,
          comment: `"${childTitle}" belongs under ${bucket.label} because it is a distinct supporting review question with the same priority and role as the grouped changes.`,
          synthetic: true,
        });
        visit(child.nodeId, nextRevealedBucketIds, nextAncestry);
      });
    }
  }

  for (const root of roots) {
    visit(root.id);
  }

  return {
    groupIds,
    nodes: visibleNodes,
    relations: miniTree.relations,
    reviewEdges: visibleReviewEdges,
  };
}

export function isAlwaysVisibleMiniNode(node) {
  return Boolean(
    node
    && (
      node.reviewClass === ALWAYS_VISIBLE_REVIEW_CLASS
      || (
        node.reviewClass === ALWAYS_VISIBLE_RUNTIME_CLASS
        && node.changeRole === "runtime"
      )
    )
  );
}

function collapseBucketForNode(node) {
  if (!node || isAlwaysVisibleMiniNode(node)) {
    return null;
  }

  if (node.reviewClass === "mechanical") {
    return {
      changeRole: "mixed",
      id: "mechanical",
      label: "Mechanical",
      reviewClass: "mechanical",
    };
  }

  const reviewClass = node.reviewClass || "supporting";
  const changeRole = node.changeRole || "other";

  return {
    changeRole,
    id: `${reviewClass}-${changeRole}`,
    label: `${capitalize(reviewClass)} ${humanizeRole(changeRole)}`,
    reviewClass,
  };
}

function collectForestNodeIds({ childrenById, rootIds }) {
  const collected = [];
  const visited = new Set();
  const stack = rootIds.slice().reverse();

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);
    collected.push(nodeId);
    const children = childrenById.get(nodeId) || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index].nodeId);
    }
  }

  return collected;
}

function humanizeRole(value) {
  return String(value).replaceAll("-", " ");
}

function capitalize(value) {
  const text = String(value);
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

function pluralize(value, count) {
  return count === 1 ? value : `${value}s`;
}
