# PR Constellation

See how one change in a PR flows into the rest — without the noise.

### Reviewing code is becoming a bottleneck

1. Current PRs show changes in a linear flat view. They do not show:
  - what code is the core change 
  - the cascading updates that change caused
  
  Worse when you're new to the codebase.
2. AI-assisted development is making
   - each PR larger and noisier
   - your inbox larger, with the same review time


### Solution

1. **Atomic PRs:** split one large PR into a few coherent pieces. Review them one at a time.
2. **Tree view:** a tree view of files and code blocks. See how changes flow from one into others.
3. **Cut the noise:** automatically hide AI-generated tests, storybook, import statements, and more. Un-hide them when you need them.
4. **What to review first:** the inbox is ranked. The highest priority PRs are at the top.


[Try the demo](https://lalitsinghrana.github.io/pr-constellation/demo/)

***Tree view***

https://github.com/user-attachments/assets/a69ca38f-6b57-48ac-be10-6c0a3ee5304f

***What to review first***

<img width="1456" height="902" alt="priority-inbox" src="https://github.com/user-attachments/assets/6c59b446-7006-4374-97a4-94bf9c527334" />

---

### Requirements

- Node.js 24 and pnpm 10
- GitHub CLI
- A local AI agent

### Getting started

```sh
nvm use
pnpm install
gh auth login
pnpm dev
```

- Open the URL shown in the terminal (default [http://127.0.0.1:4397/](http://127.0.0.1:4397/))
- Add teammates and teams in **Settings → Team**

### Roadmap

[ROADMAP.md](ROADMAP.md)

### Troubleshooting

- **Agent probe fails:** install and sign in to your agent, or switch provider in Settings

### License

[MIT](LICENSE)
