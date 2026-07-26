import { createDiffInventory, createDiffSummary } from "../03-build-diff-inventory/diff-inventory.js";

const inventory = createDiffInventory(`diff --git a/src/example.js b/src/example.js
index 0000000..1111111 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1,2 +1,3 @@
 const stable = true;
-const value = 1;
+const value = 2;
+console.log(value);
`);
const summary = createDiffSummary(inventory);

assertEqual(inventory.schemaVersion, "diff-inventory/v1", "schema version");
assertEqual(inventory.files.length, 1, "file count");
assertEqual(inventory.files[0].path, "src/example.js", "file path");
assertEqual(inventory.files[0].hunks.length, 1, "hunk count");
assertEqual(inventory.changedLineCount, 3, "changed line count");
assertEqual(inventory.changedLines.map((line) => line.kind).join(","), "delete,insert,insert", "changed line kinds");
assertEqual(inventory.changedLines.map((line) => line.id).join(","), "file-1:hunk-1:line-2,file-1:hunk-1:line-3,file-1:hunk-1:line-4", "changed line ids");
assertEqual(summary.schemaVersion, "diff-summary/v1", "summary schema version");
assertEqual(summary.files.length, 1, "summary file count");
assertEqual(summary.files[0].hunks[0].lines.length, 3, "summary changed line count");
assertEqual(summary.files[0].hunks[0].lines.map((line) => line.id).join(","), inventory.changedLines.map((line) => line.id).join(","), "summary changed line ids");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Expected ${label} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
