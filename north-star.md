Next improvements

### Target 1.0.0
#### Quick
- [ ] Something to delete ai-analysis and other data after PR is merged/closed or older than certain time since marked as done or something.
- [ ] Manually add a PR to the inbox. Cases where people ask for review in slack without adding me directly. Requesting self-review doesn't add it to GH inbox.

#### Time consuming
- [ ] Long git-diff files break out of node boundaries. http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-19-picnic-store-config-4993/ or http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-19-picnic-store-config-4993/ or http://127.0.0.1:4397/reviews/gh-17-picnicsupermarket-16-picnic-store-app-3558/
- [ ] Review comments improvements:
  - The box can be more wider and scrollable for content inside it.
  - Existing review comment threads should be open by default.
  - Is it possible to have this anchor to the node, float to left of node, but doesn't take space in node or group wrapper. It should scroll with the node anchor point.
  - use: https://github.com/PicnicSupermarket/picnic-store-config/pull/4919#discussion_r3702665359 as test target
  - When typing comments edges flickers. There might be re-rendering happening


### Target 2.0.0
- [ ] Timer to review the PRs. Each review-stack should have their own timer based on #LOC. No need for AI, we can deterministically do this.
- [ ] Sort by Simple-smallest, Simple-large, complex-large to get smaller ones get finished quickly
- [ ] Set-up notifications in-browser or slack
- [ ] Make it available in VS/Cursor as extension
- [ ] Review side panel to take inspiration from GH review side panel

---

- Explore memory-graph by BE team
- llm-wiki for repo?
- https://deepwiki.com/
