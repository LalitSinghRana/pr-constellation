Next improvements

### Target 1.0.0
#### Quick
- [x] ~~move team settings, scoring card (simplify) to settings page.~~
- [x] ~~"Mark as done" should also mark notifications on GH as done.~~
- [ ] Setting and Analyze queue to open in same tab by default now.
- [ ] Move 0.1x / 1x / 10x toggle from header to inside the scope of review-trees
- [ ] Merge rows b/w home-page and /analysis-queue. The expand feature in /analysis-queue row is behind a flag in this component. First check and find all the difference, so there's no regression.
- [ ] We need closed PR tab also on left. Anything else we are missing?
- [ ] clean up AI agentic workflow to not mention claude/codex/grok/or any other LLM name or do anything specific for them. The whole pipeline should be agnostic to LLM provider.

#### Time consuming
- [ ] Remove Picnic as the product default. In settings Users should provide PRs to track. Do we need these now or only rely on notifications?
- [ ] Long git-diff files break out of node boundaries. http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-19-picnic-store-config-4993/ or http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-19-picnic-store-config-4993/ or http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-16-picnic-store-app-3558/
- [ ] Review comments improvements:
  - The box can be more wider and scrollable for content inside it.
  - Existing review comment threads should be open by default.
  - Is it possible to have this anchor to the node, float to left of node, but doesn't take space in node or group wrapper. It should scroll with the node anchor point.
  - use: https://github.com/PicnicSupermarket/picnic-store-config/pull/4919#discussion_r3702665359 as test target
  - When typing comments edges flickers. There might be re-rendering happening
  - In "review" button, we show other existing comments also. It should only show draft comments only.


### Target 2.0.0
- [ ] Timer to review the PRs. Each review-stack should have their own timer based on #LOC. No need for AI, we can deterministically do this.
- [ ] Sort by Simple-smallest, Simple-large, complex-large to get smaller ones get finished quickly
- [ ] Set-up notifications in-browser or slack
- [ ] Make it available in VS/Cursor as extension

---

- Explore memory-graph by BE team
- llm-wiki for repo?
- https://deepwiki.com/
