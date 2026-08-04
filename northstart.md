I've problem of reviewing PRs from part of codebase I've never worked on before. I don't have non-technical context and technical context to review PR throughly. Now with AI coding there are so many and so large PRs. It is becoming hard to review things.

I want to create something that will help humans review PR faster. Goals are
- cutting through noise and only focusing on key parts
- Walk humans through code changes in logical way, instead of current git thing of "here's all files in alphabatic order". What I want is this is the core change, and that change caused/required these other changes and those caused/required these other changes.
- Basically idea is to human has to review only 10% or less of the actual code changes.
- Add some AI comments on what and why the change.


Next improvements

### UI/UX
- ~Fix UI of each gig-diff node starting from 1 instead of their correct line number.~
- tailwind and design sytem should be used over CSS. Keep graph view out of this refactor consideration
- graph and rest of website should be merge for style
- clean graph UI - a lot to be done here
- a clean snap flow from file to file or node-to-node. with arrow navigation
- Configure review-stack refences in UI

###AI layer
- ~build layer flow (middle tree)~
- should we skip generated files from analyse pipeline? Like snapshots.
- Hide noise

---

- Explore memory-graph by BE team
- llm-wiki for repo?
- https://deepwiki.com/



