import assert from "node:assert/strict";
import {
  collectBriefingTextErrors,
  collectTitleTextErrors,
} from "../05-validate-candidate/briefing-checks.js";

const label = "test briefing";

assert.deepEqual(
  collectBriefingTextErrors(
    "This file changed to wire recipe grouping through the basket delete flow.",
    { label },
  ),
  [
    `${label} must not open with file-meta or code narration (This file, Adds, Import, Declare, Build, Expose).`,
  ],
);

assert.deepEqual(
  collectBriefingTextErrors(
    "Shoppers can remove an entire recipe in one action. Wrong line targeting would leave items in the basket or fire analytics on a failed request.",
    { label },
  ),
  [],
);

assert.deepEqual(collectBriefingTextErrors("What: delete flow. Why: recipe grouping.", { label }), [
  `${label} must not use What: or Why: labels.`,
]);

assert.deepEqual(
  collectBriefingTextErrors("Review this handler before approving the stack.", { label }),
  [`${label} must not include review directives such as "review this" or "inspect next".`],
);

assert.deepEqual(
  collectBriefingTextErrors("These files belong together because they share cart commands.", {
    label,
    stackBriefing: true,
  }),
  [`${label} must state the shared outcome, not meta-grouping language.`],
);

assert.deepEqual(
  collectBriefingTextErrors("Skip empty removals", {
    label,
    title: "Skip empty removals",
  }),
  [`${label} must add information the title cannot carry alone (title-plus violation).`],
);

assert.deepEqual(
  collectBriefingTextErrors(
    "Empty removal requests should be ignored so shoppers do not send no-op cart commands.",
    {
      label,
      title: "Skip empty removals",
    },
  ),
  [],
);

assert.deepEqual(
  collectTitleTextErrors("Import the cart-line removal builder", { label: "test title" }),
  [
    "test title must name the reviewer question, not the code verb (Import, Declare, Build, Expose, Adds).",
  ],
);

assert.deepEqual(collectTitleTextErrors("Skip empty removals", { label: "test title" }), []);

assert.deepEqual(
  collectBriefingTextErrors("Adds cart-line removal to the modify-cart action.", { label }),
  [
    `${label} must not open with file-meta or code narration (This file, Adds, Import, Declare, Build, Expose).`,
  ],
);

assert.deepEqual(
  collectBriefingTextErrors(
    "Enable shoppers to remove a whole recipe from the basket in one action.",
    { label: "analysis.json intent" },
  ),
  [],
);
