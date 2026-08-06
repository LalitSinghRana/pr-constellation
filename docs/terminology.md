# Terminology

- **Review Tree**: the complete navigable review view for one pull request.
- **Review Stack**: a coherent group of changed files reviewed as one unit.
- **Stack Tree**: the ordered file-to-file tree inside one Review Stack.
- **File Node**: one changed file in a Stack Tree; it contains a File Review Tree.
- **File Review Tree**: the ordered tree of Review Sections inside one file.
- **Review Section**: one cohesive changed-code unit shown to the reviewer.
- **Review Branch**: an ordered parent-child relationship in either tree.
- **Review Group**: a collapsed set of lower-priority sibling branches.
- **Review Step**: one navigation stop: a file, section, or group.
- **Review Tree Map**: the overview used to navigate the current tree.

The analysis contract uses `reviewStacks`, `stackTree`, `fileTree`, `sections`,
and `branches`. A branch identifies its `parentId` and `childId`. Review value is
`reviewPriority` (`primary`, `secondary`, or `skim`); implementation category is
`changeKind`; human-facing context is `explanation`.
