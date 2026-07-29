I've problem of reviewing PRs from part of codebase I've never worked on before. I don't have non-technical context and technical context to review PR throughly. Now with AI coding there are so many and so large PRs. It is becoming hard to review things.

I want to create something that will help humans review PR faster. Goals are
- cutting through noise and only focusing on key parts
- Walk humans through code changes in logical way, instead of current git thing of "here's all files in alphabatic order". What I want is this is the core change, and that change caused/required these other changes and those caused/required these other changes.
- Basically idea is to human has to review only 10% or less of the actual code changes.
- Add some AI comments on what and why the change.


Next improvements

### UI/UX
- ~add code coloring~
- Hide noise

###AI layer
- Add determenistic diff patch coverage
- Maybe don't split code wihtin files. Let's start there as people are more comfortable with that.
- Need more improvement in AI comments
  - Label files and changes inside them as important or noise. Actual code change is imporatant. types, storybook, test, snapshoot, etc changes or files are noise.
  - Don't have to start with single core file change. If you think multiple files are core change, we can start them as node group. But try to keep them as core and minimal as possible.
  - Same goes with other changes/files down the tree. If multiple files or changes are a collective make them a group.
  - Better yet should we use group nodes to group related collective changes in one. Within group we can have our mini-tree walkthrough explaination. And then bigger groups can form outer big tree walkthrough.
  - Each comment should have "what is going on"? and then "how it is doing"?
  - Add hove comment in each section of related code block???? Maybe too much?

- ??? use virtual gitstack


---

- Explore memory-graph by BE team
- llm-wiki for repo?
- https://deepwiki.com/




---

Yes. I’d separate this into three different problems, because mixing them is probably why the AI output feels weak.

**1. Graph Generation**
I agree with backing away from tiny code blocks for now.

Better model:

- UI still renders each changed file as one normal diff block.
- AI creates logical graph nodes like “Add OTP press handling” or “Update validation path”.
- Each graph node points to one or more file sections.
- File sections are just metadata ranges inside a file diff, not separate UI chunks.
- Every changed line belongs to a section, even if that section is marked noise.

So the graph becomes:

```txt
core change
  -> required file sections
  -> downstream file sections
  -> tests / mechanical / noise
```

This avoids forcing the model to invent perfect tiny chunks while still giving us coverage and navigation.

**2. Coverage / Judge Agent**
Strong pushback: the judge agent should not be the only thing ensuring no line is missed.

The reliable version is:

1. Deterministic parser reads the patch.
2. It creates `diff-inventory.json` with every changed file, hunk, and changed line ID.
3. AI assigns every changed line or hunk range to a section.
4. Local validator checks:
   - every changed line is covered
   - no invalid file/range references
   - no orphan graph nodes
   - every section is classified
5. Judge agent reviews the AI output for semantic mistakes:
   - “this section marked noise but looks risky”
   - “this test section is actually validating core behavior”
   - “this edge explanation is weak”
6. If validation or judge review fails, retry generation from scratch using
   both results as feedback.

So the judge is semantic. Coverage is deterministic.

**3. Splitting Big PRs**
I would not jump to real stacked PR generation yet.

Actual git-stack splitting is much harder than review splitting:

- Requires checking out the repo locally.
- Needs build/test commands.
- Needs confidence that each generated branch compiles independently.
- Could accidentally rewrite author intent.
- Large PRs often have tangled commits that do not split cleanly.

I’d do “virtual stacks” first:

```txt
Review Stack 1: core behavior
Review Stack 2: required integration changes
Review Stack 3: tests
Review Stack 4: mechanical/noise
```

This gives humans the review benefit without mutating git history. Later, if the virtual stacks are useful, we can add an optional “try to materialize this as stacked branches” command.

My recommended next architecture:

```txt
fetch PR patch
  -> deterministic diff inventory
  -> analyzer agent creates graph + sections
  -> validator enforces full line coverage
  -> judge agent critiques risk/coverage/logic
  -> retry generation when validator or judge fails
  -> final analysis.json
  -> webview renders file diffs + graph navigation
```

Key question before implementation: when you say “no code diff line is missed,” do you mean only added/deleted lines, or also unchanged context lines inside hunks? My default would be added/deleted lines only, with context lines available but not required for coverage.
