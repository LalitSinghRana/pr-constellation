# Terminology

- **Inbox**: the home page of GitHub notification threads still in the GitHub
  inbox, ranked into lifecycle views such as Unreviewed, Merged, and Closed.
  Notifications about your currently open authored pull requests are excluded
  from those lifecycle views. **My pull requests** is only open PRs you authored.
  Quiet rows stay in that list as read until a new GitHub notification arrives.
  Merged or closed authored PRs belong in Merged or Closed when they remain in
  the GitHub inbox.
- **Review Tree**: the complete navigable review view for one pull request.
- **Review Stack**: a coherent group of changed files reviewed as one unit.
- **File Tree**: the ordered tree of Files inside one Review Stack.
- **File Node**: one changed file in a File Tree; it contains a Section Tree.
- **Section Tree**: the ordered tree of Review Sections inside one file.
- **Review Section**: one cohesive changed-code unit shown to the reviewer.
- **Review Branch**: an ordered parent-child relationship in either tree.
- **Review Group**: a collapsed set of lower-priority sibling branches.
- **Review Step**: one navigation stop: a file, section, or group.
- **Review Tree Map**: the overview used to navigate the current tree.

The analysis contract uses `reviewStacks`, `fileTree`, `sectionTree`, `sections`,
and `branches`. A branch identifies its `parentId` and `childId`. Review value is
`reviewPriority` (`primary`, `secondary`, or `skim`); implementation category is
`changeKind`; human-facing context is `explanation`.
