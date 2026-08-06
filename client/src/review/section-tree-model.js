// Pure Section Tree normalization and folding for generated review pages.
const ALWAYS_VISIBLE_RUNTIME_PRIORITY = "primary";

export function normalizeSectionTree(file) {
  const sectionTree = file?.sectionTree || {};
  return {
    branches: sectionTree.branches || [],
    sections: sectionTree.sections || [],
  };
}

export function foldSectionTree(file, { expandedGroupIds = [] } = {}) {
  const sectionTree = normalizeSectionTree(file);
  const expandedIds =
    expandedGroupIds instanceof Set ? expandedGroupIds : new Set(expandedGroupIds);
  const sectionById = new Map(sectionTree.sections.map((section) => [section.id, section]));
  const sectionOrderById = new Map(
    sectionTree.sections.map((section, order) => [section.id, order]),
  );
  const childrenById = new Map(sectionTree.sections.map((section) => [section.id, []]));
  const incomingIds = new Set();

  for (const branch of sectionTree.branches) {
    if (
      branch.parentId === branch.childId ||
      !sectionById.has(branch.parentId) ||
      !sectionById.has(branch.childId) ||
      incomingIds.has(branch.childId)
    ) {
      continue;
    }

    childrenById.get(branch.parentId).push({
      branch,
      sectionId: branch.childId,
    });
    incomingIds.add(branch.childId);
  }

  for (const children of childrenById.values()) {
    children.sort((left, right) => {
      return (
        left.branch.order - right.branch.order ||
        (sectionOrderById.get(left.sectionId) || 0) - (sectionOrderById.get(right.sectionId) || 0)
      );
    });
  }

  const roots = sectionTree.sections
    .filter((section) => !incomingIds.has(section.id))
    .sort((left, right) => {
      return (sectionOrderById.get(left.id) || 0) - (sectionOrderById.get(right.id) || 0);
    });
  const rootIds = new Set(roots.map((root) => root.id));
  const visibleSections = [];
  const visibleBranches = [];
  const visibleSectionIds = new Set();
  const groupIds = [];
  const subtreeVisibilityMemo = new Map();

  function subtreeContainsAlwaysVisible(sectionId, ancestry = new Set()) {
    if (subtreeVisibilityMemo.has(sectionId)) {
      return subtreeVisibilityMemo.get(sectionId);
    }
    if (ancestry.has(sectionId)) {
      return false;
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(sectionId);
    const section = sectionById.get(sectionId);
    const containsVisible =
      isAlwaysVisibleReviewSection(section, { rootIds }) ||
      (childrenById.get(sectionId) || []).some((child) => {
        return subtreeContainsAlwaysVisible(child.sectionId, nextAncestry);
      });

    subtreeVisibilityMemo.set(sectionId, containsVisible);
    return containsVisible;
  }

  function addVisibleSection(section) {
    if (visibleSectionIds.has(section.id)) {
      return;
    }

    visibleSectionIds.add(section.id);
    visibleSections.push(section);
  }

  function visit(sectionId, revealedBucketIds = new Set(), ancestry = new Set()) {
    if (ancestry.has(sectionId)) {
      return;
    }

    const section = sectionById.get(sectionId);
    if (!section) {
      return;
    }

    addVisibleSection(section);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(sectionId);
    const directChildren = [];
    const foldedByBucketId = new Map();

    for (const child of childrenById.get(sectionId) || []) {
      const childSection = sectionById.get(child.sectionId);
      const bucket = collapseBucketForSection(childSection, { rootIds });
      const staysVisible =
        !bucket ||
        revealedBucketIds.has(bucket.id) ||
        subtreeContainsAlwaysVisible(child.sectionId);

      if (staysVisible) {
        directChildren.push(child);
        continue;
      }

      const group = foldedByBucketId.get(bucket.id) || {
        bucket,
        children: [],
        firstOrder: child.branch.order,
      };
      group.children.push(child);
      group.firstOrder = Math.min(group.firstOrder, child.branch.order);
      foldedByBucketId.set(bucket.id, group);
    }

    const childEntries = [
      ...directChildren.map((child) => ({
        kind: "section",
        order: child.branch.order,
        value: child,
      })),
      ...[...foldedByBucketId.values()].map((group) => ({
        kind: "group",
        order: group.firstOrder,
        value: group,
      })),
    ].sort((left, right) => left.order - right.order);

    for (const childEntry of childEntries) {
      if (childEntry.kind === "section") {
        const child = childEntry.value;
        visibleBranches.push(child.branch);
        visit(child.sectionId, revealedBucketIds, nextAncestry);
        continue;
      }

      const { bucket, children } = childEntry.value;
      const groupSectionId = `ui-fold-${sectionId}-${bucket.id}`;
      const groupId = `${file.id}:${groupSectionId}`;
      const expanded = expandedIds.has(groupId);
      const forestSectionIds = collectForestSectionIds({
        childrenById,
        rootIds: children.map((child) => child.sectionId),
      });
      const forestSections = forestSectionIds
        .map((forestSectionId) => sectionById.get(forestSectionId))
        .filter(Boolean);
      const lineCount = forestSections.reduce((total, forestSection) => {
        return total + (forestSection.changedLineIds || []).length;
      }, 0);
      const groupSection = {
        id: groupSectionId,
        title: bucket.label,
        reviewPriority: bucket.reviewPriority,
        changeKind: bucket.changeKind,
        explanation: `${bucket.label} groups lower-priority changes that support "${section.title}".\n\n- What: ${children.length} related review ${pluralize("branch", children.length)} covering ${forestSections.length} sections.\n- Why: They share the same review priority and change kind, so the reviewer can inspect them together after the parent question.`,
        changedLineIds: [],
        reviewGroup: {
          bucketId: bucket.id,
          expanded,
          groupId,
          lineCount,
          sectionCount: forestSections.length,
          rootSectionIds: children.map((child) => child.sectionId),
          rootTitles: children
            .map((child) => sectionById.get(child.sectionId)?.title)
            .filter(Boolean),
          branchCount: children.length,
        },
      };

      groupIds.push(groupId);
      addVisibleSection(groupSection);
      visibleBranches.push({
        parentId: sectionId,
        childId: groupSectionId,
        order: childEntry.order,
        explanation: `${bucket.label} follows "${section.title}" because these lower-priority changes support that parent question without replacing its primary review focus.`,
        synthetic: true,
      });

      if (!expanded) {
        continue;
      }

      const nextRevealedBucketIds = new Set(revealedBucketIds);
      nextRevealedBucketIds.add(bucket.id);

      children.forEach((child, order) => {
        const childTitle = sectionById.get(child.sectionId)?.title || child.sectionId;
        visibleBranches.push({
          parentId: groupSectionId,
          childId: child.sectionId,
          order,
          explanation: `"${childTitle}" belongs under ${bucket.label} because it is a distinct lower-priority review question with the same priority and change kind as the grouped changes.`,
          synthetic: true,
        });
        visit(child.sectionId, nextRevealedBucketIds, nextAncestry);
      });
    }
  }

  for (const root of roots) {
    visit(root.id);
  }

  return {
    branches: visibleBranches,
    groupIds,
    sections: visibleSections,
  };
}

export function isAlwaysVisibleReviewSection(section, { rootIds } = {}) {
  return Boolean(
    section &&
      (rootIds?.has(section.id) ||
        (section.reviewPriority === ALWAYS_VISIBLE_RUNTIME_PRIORITY &&
          section.changeKind === "runtime")),
  );
}

function collapseBucketForSection(section, { rootIds } = {}) {
  if (!section || isAlwaysVisibleReviewSection(section, { rootIds })) {
    return null;
  }

  if (section.reviewPriority === "skim") {
    return {
      changeKind: "mixed",
      id: "skim",
      label: "Skim",
      reviewPriority: "skim",
    };
  }

  const reviewPriority = section.reviewPriority || "secondary";
  const changeKind = section.changeKind || "other";

  return {
    changeKind,
    id: `${reviewPriority}-${changeKind}`,
    label: `${capitalize(reviewPriority)} ${humanizeKind(changeKind)}`,
    reviewPriority,
  };
}

function collectForestSectionIds({ childrenById, rootIds }) {
  const collected = [];
  const visited = new Set();
  const stack = rootIds.slice().reverse();

  while (stack.length > 0) {
    const sectionId = stack.pop();
    if (visited.has(sectionId)) {
      continue;
    }

    visited.add(sectionId);
    collected.push(sectionId);
    const children = childrenById.get(sectionId) || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index].sectionId);
    }
  }

  return collected;
}

function humanizeKind(value) {
  return String(value).replaceAll("-", " ");
}

function capitalize(value) {
  const text = String(value);
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

function pluralize(value, count) {
  return count === 1 ? value : `${value}s`;
}
