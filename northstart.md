I've problem of reviewing PRs from part of codebase I've never worked on before. I don't have non-technical context and technical context to review PR throughly. Now with AI coding there are so many and so large PRs. It is becoming hard to review things.

I want to create something that will help humans review PR faster. Goals are
- cutting through noise and only focusing on key parts
- Walk humans through code changes in logical way, instead of current git thing of "here's all files in alphabatic order". What I want is this is the core change, and that change caused/required these other changes and those caused/required these other changes.
- Basically idea is to human has to review only 10% or less of the actual code changes.
- Add some AI comments on what and why the change.


Next improvements

### UI/UX
- ~Fix UI of each gig-diff node starting from 1 instead of their correct line number.~
- ~tailwind and design sytem should be used over CSS. Keep graph view out of this refactor consideration~
- ~a clean snap flow from file to file or node-to-node. with arrow navigation~
- ~graph and rest of website should be merge for style~
- ~clean graph UI - a lot to be done here~
  - From hover comment on node/edges, remove the "Node: What / Why", "title". Comment should only mention what is going on. Never say review this or reviewer should pay attention to xyz in comment. If there are some cases, ai think reviewer should pay attention or check this specifically, do that as next seciton/paragraph and start with "Reviewr attention:".
  - Comment hover text should be good contrast and readable comfortably. maybe also increase font size?
  - The count of +/- lines change should be green and red as shiki style
  - ~I don't think we need "OPEN" text, the color of the icon before PR number should indicate that info. Similar color to state representaion as github~
- Do full review and leave comments from my local website
- ~move rendering and shiki styling from backend to frontend.~
- set-up notifications
- Configure review-stack refences in UI

###AI layer
- ~build layer flow (middle tree)~
- should we skip generated files from analyse pipeline? Like snapshots.
- ~Hide noise~

### DX
- ~Better, consistent and meaningful terms for everything~
- ~Reorganize into mini-projects. server, client, ai-workflow~
- ~Wrise agent.md for coding guidelines~
- ~setup biome~
- ~cleanup code using agent.md~
- ~do proper server project. Should be light weight to run continously with low CPU usage. We can go other language other than JS here.~

---

- Explore memory-graph by BE team
- llm-wiki for repo?
- https://deepwiki.com/
