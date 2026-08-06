I've problem of reviewing PRs from part of codebase I've never worked on before. I don't have non-technical context and technical context to review PR throughly. Now with AI coding there are so many and so large PRs. It is becoming hard to review things.

I want to create something that will help humans review PR faster. Goals are
- cutting through noise and only focusing on key parts
- Walk humans through code changes in logical way, instead of current git thing of "here's all files in alphabatic order". What I want is this is the core change, and that change caused/required these other changes and those caused/required these other changes.
- Basically idea is to human has to review only 10% or less of the actual code changes.
- Add some AI comments on what and why the change.


Next improvements

### UI/UX
- ~Fix each Review Section starting at 1 instead of its correct line number.~
- ~Use Tailwind and the design system over bespoke CSS. Keep the Review Tree out of this refactor.~
- ~Add clean snap navigation from file to file or section to section with arrow navigation.~
- ~Match the Review Tree styling to the rest of the website.~
- Clean up the Review Tree UI.
- set-up notifications
- Configure Review Stack references in the UI.

### AI layer
- ~Build the File Tree.~
- should we skip generated files from analyse pipeline? Like snapshots.
- Hide noise

### DX
- Better, consistent and meaningful terms for everything
- Reorganize into subprojects: server, client, and analysis workflow.
- Clean up Review Tree rendering with clear boundaries and guardrails for AI changes.
- do proper server project. Should be light weight to run continously with low CPU usage. We can go other language other than JS here.

---

- Explore the BE team's memory system.
- llm-wiki for repo?
- https://deepwiki.com/


