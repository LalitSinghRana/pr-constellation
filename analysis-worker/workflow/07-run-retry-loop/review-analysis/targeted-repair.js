import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStructuredDiff,
  compactLineOwnership,
  materializeLineOwnership,
} from "./structured-diff.js";

const REVIEW_TREES_SCHEMA_PATH = path.join(
  path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
  "04-generate-candidate-analysis",
  "03-create-review-trees",
  "schema.json",
);

async function runJsonStage(options) {
  const { runJsonStage: runStage } = await import("../review-analysis.js");
  return runStage(options);
}

export async function runTargetedRepair({
  candidate,
  cwd,
  evaluation,
  executionConfig,
  execute,
  inventory,
  outputPath,
  promptPath,
  repairScope,
}) {
  const repairPayload = materializeLineOwnership(
    await runJsonStage({
      cwd,
      executionConfig,
      execute,
      outputPath,
      prompt: buildTargetedRepairPrompt({
        candidate,
        evaluation,
        inventory,
        repairScope,
      }),
      promptPath,
      schemaPath: REVIEW_TREES_SCHEMA_PATH,
    }),
    { inventory },
  );

  validateRepairPayload({
    candidate,
    inventory,
    repairPayload,
    repairScope,
  });

  return mergeTargetedRepair({
    candidate,
    inventory,
    repairPayload,
  });
}

function buildTargetedRepairPrompt({ candidate, evaluation, inventory, repairScope }) {
  const affectedFileIdsText = `${JSON.stringify(repairScope.fileIds)}\n`;
  const affectedDiffText = `${JSON.stringify(
    buildAffectedDiffInput({ inventory, repairScope }),
  )}\n`;
  const candidateText = `${JSON.stringify(compactLineOwnership(candidate))}\n`;
  const feedbackText = `${JSON.stringify(buildCombinedFeedback(evaluation))}\n`;

  return `# Targeted Section Tree Repair

Repair only the Section Trees named in \`affected_file_ids\`. Return JSON that
matches the PR section tree schema, but include exactly those complete replacement
file entries in the top-level \`files\` array. Copy the current candidate's
\`intent\`, \`summary\`, and \`confidence\` values; the runner preserves the
current top-level values, File Trees, and every unaffected file. Include an
empty \`fileTree.branches\` array to satisfy the repair transport schema; the
runner discards that placeholder.

Use the combined deterministic-validation and semantic-judge feedback
together. Fix every reported issue for an affected file without changing its
inventory file id or path. Every replacement Section Tree must cover all of
that file's changed lines exactly once. Return only the repair JSON.

## Affected file ids

<affected_file_ids_json>
${affectedFileIdsText}</affected_file_ids_json>

## Combined evaluation feedback

<combined_evaluation_feedback_json>
${feedbackText}</combined_evaluation_feedback_json>

## Current complete candidate

<analysis_candidate_json>
${candidateText}</analysis_candidate_json>

## Affected file and hunk input

This is the only source input needed for the repair. It intentionally excludes
unaffected files and hunks.

<affected_diff_json>
${affectedDiffText}</affected_diff_json>

Return exactly one complete replacement entry for every affected file id and no
entry for an unaffected file.
`;
}

function buildCombinedFeedback(evaluation) {
  return {
    schemaVersion: "pr-review-evaluation-feedback/v1",
    deterministicValidation: evaluation.validationFailure
      ? {
          status: "fail",
          report: evaluation.validationFailure,
        }
      : {
          status: "pass",
          report: "Deterministic validation accepted the candidate.",
        },
    semanticJudge: evaluation.judge
      ? {
          status: evaluation.judge.verdict,
          summary: evaluation.judge.summary,
          findings: evaluation.judge.findings || [],
        }
      : {
          status: evaluation.judgeSkipped ? "skipped" : "error",
          report: evaluation.judgeFailure,
        },
  };
}

function buildAffectedDiffInput({ inventory, repairScope }) {
  const hunkIdsByFileId = new Map(
    repairScope.files.map((scopeFile) => [
      scopeFile.id,
      scopeFile.hunkIds === null ? null : new Set(scopeFile.hunkIds),
    ]),
  );

  return buildStructuredDiff(inventory, { hunkIdsByFileId });
}

export function resolveRepairScope({ candidate, evaluation, inventory }) {
  const changedFiles = (inventory?.files || []).filter((file) => file.changedLineIds?.length > 0);
  const fileById = new Map(changedFiles.map((file) => [file.id, file]));
  const fileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const hunkById = new Map();
  const lineLocationById = new Map();
  const sectionLocationsById = new Map();
  const affectedHunksByFileId = new Map();

  for (const file of changedFiles) {
    for (const hunk of file.hunks || []) {
      hunkById.set(hunk.id, { file, hunk });
      for (const line of hunk.lines || []) {
        lineLocationById.set(line.id, { file, hunk });
      }
    }
  }

  for (const candidateFile of candidate?.files || []) {
    for (const section of candidateFile?.sectionTree?.sections || []) {
      if (!isNonEmptyString(section?.id)) {
        continue;
      }
      const locations = sectionLocationsById.get(section.id) || [];
      locations.push({
        candidateFile,
        hunkIds: changedLineIdsToHunkIds(section.changedLineIds, lineLocationById),
      });
      sectionLocationsById.set(section.id, locations);
    }
  }

  const markFile = (file, hunkIds = null) => {
    if (!fileById.has(file?.id)) {
      return false;
    }

    if (hunkIds === null) {
      affectedHunksByFileId.set(file.id, null);
      return true;
    }

    if (affectedHunksByFileId.get(file.id) === null) {
      return true;
    }

    const current = affectedHunksByFileId.get(file.id) || new Set();
    for (const hunkId of hunkIds) {
      current.add(hunkId);
    }
    affectedHunksByFileId.set(file.id, current);
    return true;
  };

  const resolveIdentifier = (identifier) => {
    if (!isNonEmptyString(identifier)) {
      return false;
    }

    const file = fileById.get(identifier) || fileByPath.get(identifier);
    if (file) {
      return markFile(file);
    }

    const hunkLocation = hunkById.get(identifier);
    if (hunkLocation) {
      return markFile(hunkLocation.file, [hunkLocation.hunk.id]);
    }

    const lineLocation = lineLocationById.get(identifier);
    if (lineLocation) {
      return markFile(lineLocation.file, [lineLocation.hunk.id]);
    }

    const sectionLocations = sectionLocationsById.get(identifier);
    if (sectionLocations?.length > 0) {
      for (const location of sectionLocations) {
        const sectionFile = fileById.get(location.candidateFile.id);
        markFile(sectionFile, location.hunkIds.length > 0 ? location.hunkIds : null);
      }
      return true;
    }

    return false;
  };

  const evidence = [
    {
      targetId: "",
      text: evaluation?.validationFailure || "",
    },
    ...(evaluation?.judge?.findings || []).map((finding) => ({
      targetId: finding.targetId,
      text: finding.explanation,
    })),
  ];

  for (const item of evidence) {
    let resolvedSpecificIdentifier = resolveIdentifier(item.targetId);
    const text = item.text || "";

    for (const [lineId, location] of lineLocationById) {
      if (containsIdentifier(text, lineId)) {
        markFile(location.file, [location.hunk.id]);
        resolvedSpecificIdentifier = true;
      }
    }

    for (const [hunkId, location] of hunkById) {
      if (containsIdentifier(text, hunkId)) {
        markFile(location.file, [location.hunk.id]);
        resolvedSpecificIdentifier = true;
      }
    }

    for (const [sectionId, locations] of sectionLocationsById) {
      if (!containsIdentifier(text, sectionId)) {
        continue;
      }
      for (const location of locations) {
        const sectionFile = fileById.get(location.candidateFile.id);
        markFile(sectionFile, location.hunkIds.length > 0 ? location.hunkIds : null);
      }
      resolvedSpecificIdentifier = true;
    }

    if (resolvedSpecificIdentifier) {
      continue;
    }

    for (const file of changedFiles) {
      if (containsIdentifier(text, file.id) || (file.path && text.includes(file.path))) {
        markFile(file);
      }
    }
  }

  if (affectedHunksByFileId.size === 0) {
    return null;
  }

  const files = changedFiles
    .filter((file) => affectedHunksByFileId.has(file.id))
    .map((file) => {
      const hunkIds = affectedHunksByFileId.get(file.id);
      return {
        id: file.id,
        path: file.path,
        hunkIds: hunkIds === null ? null : [...hunkIds],
      };
    });

  return {
    fileIds: files.map((file) => file.id),
    files,
  };
}

function changedLineIdsToHunkIds(changedLineIds, lineLocationById) {
  return [
    ...new Set(
      (changedLineIds || []).map((lineId) => lineLocationById.get(lineId)?.hunk.id).filter(Boolean),
    ),
  ];
}

function containsIdentifier(text, identifier) {
  if (!text || !identifier) {
    return false;
  }

  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9:_-])${escaped}(?=$|[^A-Za-z0-9:_-])`).test(text);
}

function validateRepairPayload({ candidate, inventory, repairPayload, repairScope }) {
  const errors = [];
  const expectedIds = new Set(repairScope.fileIds);
  const replacementIds = new Set();
  const inventoryFileById = new Map((inventory?.files || []).map((file) => [file.id, file]));
  const candidateFileById = new Map((candidate?.files || []).map((file) => [file.id, file]));

  if (
    repairPayload?.schemaVersion !== "pr-review-trees/v1" ||
    !Array.isArray(repairPayload?.files)
  ) {
    errors.push("targeted repair must use pr-review-trees/v1 with a files array.");
  }

  for (const replacement of repairPayload?.files || []) {
    if (!expectedIds.has(replacement?.id)) {
      errors.push(
        `targeted repair returned unaffected or unknown file id: ${replacement?.id || "<missing>"}`,
      );
      continue;
    }
    if (replacementIds.has(replacement.id)) {
      errors.push(`targeted repair returned duplicate file id: ${replacement.id}`);
      continue;
    }
    replacementIds.add(replacement.id);

    const expectedPath =
      inventoryFileById.get(replacement.id)?.path || candidateFileById.get(replacement.id)?.path;
    if (replacement.path !== expectedPath) {
      errors.push(
        `targeted repair file ${replacement.id} path must remain ${expectedPath}; got ${replacement.path}.`,
      );
    }
  }

  for (const expectedId of expectedIds) {
    if (!replacementIds.has(expectedId)) {
      errors.push(`targeted repair omitted affected file id: ${expectedId}`);
    }
  }

  if (errors.length > 0) {
    throwValidationError(errors);
  }
}

function mergeTargetedRepair({ candidate, inventory, repairPayload }) {
  const candidateFileById = new Map((candidate.files || []).map((file) => [file.id, file]));
  const replacementFileById = new Map(repairPayload.files.map((file) => [file.id, file]));

  return {
    ...candidate,
    files: (inventory?.files || [])
      .filter((file) => file.changedLineIds?.length > 0)
      .map((file) => replacementFileById.get(file.id) || candidateFileById.get(file.id))
      .filter(Boolean),
  };
}

function throwValidationError(errors) {
  throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
