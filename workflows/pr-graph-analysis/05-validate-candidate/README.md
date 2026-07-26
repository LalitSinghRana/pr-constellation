# 05 Validate Candidate

`validate-analysis.js` deterministically checks:

- exactly one file entry and one mini-tree per changed file
- exact file id and path ownership from `diff-inventory.json`
- every changed line is assigned to exactly one mini-tree node
- every node owns one source-ordered continuous range in one hunk
- no node contains a line from another file
- file `codeRefs` exactly match its inventory lines
- mini-tree node ids and edges are valid and file-local
- each mini-tree has one root and one parent per non-root node
- each mini-tree has exactly one `core` node at its depth 0 root
- review priority flows `core > important > supporting > mechanical`
- `imports`, `type`, `generated`, and `formatting` use deterministic
  `mechanical` classification outside the core root
- `reviewClass` and `changeRole` use the approved values
