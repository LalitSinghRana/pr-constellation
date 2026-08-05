# 05 Validate Candidate

`validate-analysis.js` deterministically checks:

- exactly one file entry and one mini-tree per changed file
- exact file id and path ownership from `diff-inventory.json`
- every changed line is assigned to exactly one mini-tree node
- every AI range is forward and confined to one hunk, node ranges are
  non-overlapping and source ordered, and materialized line ids match them
- no node contains a line from another file
- file `codeRefs` exactly match its inventory lines
- ordered mini-tree review edges form one valid file-local tree
- secondary technical relations reference valid file-local mini-nodes
- each mini-tree has one root and one parent per non-root node
- `reviewClass` and `changeRole` use the approved values
- required titles, comments, and relation labels are non-empty strings

Semantic choices—including which node is the root, how review priority flows,
whether a role deserves a particular review class, and whether explanations are
useful—belong to the AI judge in Step 06.
