# PR Review Cockpit Engineering Guidelines

**Version 1.1.0**

> Durable instructions for agents maintaining this repository. Apply the
> repository-wide JavaScript rules to every JavaScript file, then apply the
> React or Node.js rules when that runtime is involved.

---

## Abstract

This guide turns the project's engineering sources into decisions an agent can
apply while editing code. It favors the smallest cohesive design that preserves
behavior, exposes clear ownership, validates external input, and remains easy to
test. Generic advice never justifies rewriting working project conventions.

Rules are ordered by scope:

1. **General JavaScript** applies to all `.js`, `.mjs`, and `.jsx` files.
2. **React** additionally applies to components, hooks, pages, and browser UI.
3. **Node.js** additionally applies to the server, CLI, analysis workflows,
   build/render code, and Node-run tests.

When rules compete, protect correctness, security, data, and accessibility
first; then preserve existing product behavior and public contracts; then
prefer the repository's established pattern over a generic source. Do not
re-architect code merely to make it resemble an example application.

---

## Table of Contents

1. [Project Workflow](#project-workflow)
2. [General JavaScript](#1-general-javascript)
3. [React](#2-react)
4. [Node.js](#3-nodejs)

---

## Project Workflow

### Read before changing

**Impact: CRITICAL**

- Trace the affected flow end to end and inspect every caller before changing a
  shared function, hook, component, or module contract.
- Search for an existing helper, component, dependency, test pattern, and
  neighboring convention before introducing a new one.
- Keep changes local to the owning feature. Do not add a top-level directory,
  architectural layer, dependency, or reusable abstraction for a hypothetical
  future use.
- When the user invokes `@agentic-workflow`, use the project-local skill at
  `.codex/skills/agentic-workflow/SKILL.md`.

### Dependencies and UI primitives

**Impact: HIGH**

- Prefer, in order: the language or platform, an existing project utility, an
  installed dependency, then a maintained package when it replaces meaningful
  generic behavior such as URL state, date parsing, or form validation.
- Before creating a UI primitive, inspect `client/src/components/ui`, the shadcn
  registry, and maintained packages. Hand-write a generic primitive only when
  none meets the interaction and accessibility requirements.
- Add shadcn components from the repository root with
  `pnpm exec shadcn add <component>` so `components.json` remains the single UI
  registry.

### Verification

**Impact: CRITICAL**

- Run the narrowest relevant check while iterating. `pnpm test` runs every
  `node:test` suite serially; a specific `*.test.js` or `*.test.mjs` file is the
  usual focused check.
- Run `pnpm check` before handing off a cross-cutting or completed change. It
  checks Biome formatting and lint diagnostics, runs all tests, and builds the
  client.
- `pnpm format` writes the whole repository. Prefer
  `pnpm exec biome format --write <touched-paths>` during focused work, and do
  not include unrelated formatting churn.
- For UI work, verify the real page with Agent Browser:

  ```sh
  pnpm ab -- open --enable react-devtools <url>
  pnpm ab -- snapshot
  pnpm ab -- errors
  pnpm ab -- console
  pnpm ab -- screenshot .context/agent-browser/current.png
  pnpm ab -- close --all
  ```

- Test the behavior most likely to regress, including a failure path when the
  change affects validation, persistence, processes, or network I/O.

### Generated reviews and local URLs

**Impact: HIGH**

- Generated review runs belong under the gitignored `.reviews/` directory. Do
  not commit them unless explicitly requested.
- Serve user-facing reviews with `pnpm dev` on the fixed port. Reuse a server
  already serving this workspace on port `4397`, or stop it before starting a
  new one; do not switch to a random port.
- Hand off the stable route
  `http://127.0.0.1:4397/reviews/<review-slug>/`, not a `file://` or timestamped
  URL. Historical revisions remain under
  `/reviews/<review-slug>/<run-id>/`.

---

## 1. General JavaScript

### 1.1 Keep code with its owner

**Impact: HIGH**

Use the existing structure rather than inventing parallel homes:

- `client/` owns the cockpit UI, generated React Flow review pages, renderer,
  Shiki integration, shared shadcn primitives, and browser-facing tests.
- `server/` owns the long-running HTTP server, GitHub synchronization,
  dashboard API, queue coordination, persistence, and server tests.
- `analysis-worker/` owns the CLI, run coordinator, PR fetching, diff
  inventory, prompts, schemas, validation, judging, retries, and analysis tests.
- `analysis-worker/workflow/` preserves the numbered headless stages. Keep
  stage-specific code, prompts, schemas, tests, and documentation with their
  current stage.
- Root files such as `package.json`, `biome.json`, `components.json`, and
  `jsconfig.json` configure all three areas.

These are ownership boundaries in one Node and pnpm project, not independent
packages or workspaces. Keep tests in the owning subproject's `tests/`
directory. `client/src/review/render.js` remains client-owned because it builds
the client artifact even though Node executes it.

Start specific and promote code to a shared directory only when multiple real
owners use the same semantic contract. A directory named `utils`, `helpers`, or
`common` is not a substitute for identifying an owner.

### 1.2 Use predictable names

**Impact: MEDIUM**

- Use kebab-case for new files and directories. Preserve established entry-file
  exceptions such as `App.jsx` and `main.jsx`.
- Use `.jsx` only for files containing JSX, `.js` for ordinary ESM modules, and
  `.mjs` only where an explicit Node ESM entry point is already the local
  convention.
- Name page files `*-page.jsx`, hooks `use-*.js`, and components by the UI or
  domain concept they represent. Name tests `*.test.js`, or `*.test.mjs` when
  the owning entry point uses `.mjs`, so Node discovers them through
  `pnpm test`.
- Use PascalCase for React components and classes; `use`-prefixed camelCase for
  hooks; camelCase for other functions, variables, and properties.
- Use camelCase for ordinary module constants. Reserve SCREAMING_SNAKE_CASE for
  established constant sets and tables whose names convey fixed configuration;
  do not uppercase a value merely because it is declared with `const`.
- Name predicates with `is`, `has`, `can`, or `should`. Include units in names
  when ambiguity matters, such as `timeoutMs` or `sizeBytes`.
- Use the canonical vocabulary from `docs/terminology.md`. Do not alternate
  between different words for the same product concept.
- Prefer searchable, pronounceable names over abbreviations. Established domain
  terms such as PR, URL, API, ID, CLI, and AI are acceptable.

### 1.3 Let formatting and linting be mechanical

**Impact: MEDIUM**

The root `biome.json` is authoritative for every subproject. Its formatter uses
spaces and a 100-column width; keep its JavaScript output, including double
quotes, semicolons, arrow-parameter parentheses, multiline trailing commas, LF
line endings, and a final newline.

- Keep imports at the top. Use `node:` for Node built-ins. Use `@/` only in
  Vite/browser modules; native Node modules use explicit relative paths and file
  extensions. Import project modules directly instead of adding barrel files,
  and respect a package's documented exports rather than guessing deep paths.
- Use `const` by default, `let` only for reassignment, and never `var`.
- Use `===` and `!==`; avoid implicit globals, assignment inside expressions,
  sparse arrays, async Promise executors, and floating promises.
- Remove unused imports, variables, unreachable branches, commented-out code,
  and redundant casts or conditions.
- Do not disable a lint rule merely to finish a change. A necessary suppression
  must be narrow and include the concrete reason the rule cannot apply.
- Biome reports selected accessibility rules, exhaustive hook dependencies, and
  array-index keys as warnings. `pnpm check` rejects formatting differences and
  error-level diagnostics; warnings remain non-failing but visible. Resolve
  relevant warnings in touched code.
- Review unsafe Biome fixes individually and run the relevant tests. Do not
  apply a repository-wide formatter or fixer as part of an unrelated change.
- Do not mix behavior changes with unrelated formatting churn.

### 1.4 Climb the abstraction ladder

**Impact: CRITICAL**

Stop at the first level that expresses the current requirement clearly:

1. Keep a simple one-use operation inline.
2. Extract a private function when its name lets the caller stay at one level
   of abstraction, or when it isolates a non-trivial transformation worth
   testing.
3. Extract a shared module only when multiple real callers share the same
   concept, invariant, and change cadence.
4. Introduce an object with hidden state only when state and lifecycle belong
   together.
5. Introduce a strategy, interface, factory, or injected dependency only when
   multiple implementations exist, a trust boundary needs isolation, or a test
   must substitute expensive or nondeterministic I/O.

An abstraction is failing when callers must pass mode flags, duplicate its
internal conditions, unwrap its data to do useful work, or change whenever an
unrelated feature changes. Simplify or remove it instead of adding another
layer.

### 1.5 Split by responsibility, not size

**Impact: HIGH**

Split a function, component, or module when it:

- has more than one independent reason to change;
- mixes policy or transformation with network, filesystem, process, or DOM I/O;
- requires a vague name because it represents multiple concepts;
- contains a cohesive part with its own contract, reuse, state, or meaningful
  test cases; or
- forces unrelated callers or tests to know about each other.

Keep code together when the pieces always change together and extraction would
only add indirection, prop plumbing, options, or pass-through wrappers. File
length and argument count are review signals, not automatic split thresholds.
Prefer an options object when several arguments form one concept; do not use it
to hide an incoherent function.

### 1.6 Apply DRY and SOLID to knowledge

**Impact: HIGH**

- **DRY:** centralize a business rule, schema, mapping, or invariant that must
  change in one place. Tolerate small coincidental duplication until the shared
  concept and ownership are proven.
- **Single responsibility:** give a unit one reason to change, not merely one
  operation per file.
- **Open/closed:** use composition or a data-driven table for real variants;
  do not pre-build extension points.
- **Liskov substitution:** a subtype must preserve its caller-visible contract.
  Prefer composition when that promise is awkward.
- **Interface segregation:** expose the smallest data or behavior a consumer
  needs. In JavaScript, a narrow function or object is usually enough.
- **Dependency inversion:** keep policy independent from volatile I/O by
  passing boundary behavior where substitution is useful. Do not inject every
  pure helper.

Favor composition over inheritance. Do not create a class, base class, or
single-implementation interface solely to demonstrate a principle.

### 1.7 Encapsulate state and side effects

**Impact: HIGH**

- Export the smallest stable API. Keep mutable state private to its module or
  instance and expose operations that preserve its invariants.
- Treat parameters, returned snapshots, React state, and shared records as
  immutable. Local mutation is acceptable inside a contained calculation when
  it cannot escape and is clearer or measurably cheaper.
- Keep pure transformations separate from side effects. Make time, randomness,
  filesystem access, subprocesses, and network calls explicit at useful test
  seams.
- Avoid module initialization with externally visible side effects. Initialize
  resources deliberately and make cleanup explicit.
- Prefer early returns and positive conditions when they reduce nesting. Extract
  a named predicate when a business condition is difficult to read.

### 1.8 Make failures explicit

**Impact: CRITICAL**

- Validate data at trust boundaries before performing side effects.
- Never ignore a caught error or rejected promise. Recover, translate it at the
  owning boundary, or rethrow it with useful context and `cause`.
- Create an error subclass or stable error code only when a caller makes a real
  decision from it. A descriptive `Error` is otherwise sufficient.
- Preserve the original stack where possible. Await work whose rejection belongs
  to the current operation.
- Comments explain business reasons, invariants, compatibility constraints, or
  surprising tradeoffs. Do not narrate obvious syntax or keep journal comments.

### 1.9 Test behavior and risk

**Impact: HIGH**

- Test public behavior and observable outcomes, not private implementation
  details.
- Add the smallest test that would fail if new branching, parsing, persistence,
  security, or money/data-sensitive logic regressed. Trivial delegation and
  formatter-only changes need no new test.
- Give each test one behavior and a name that identifies the condition and
  expected outcome. Cover the important failure path, not only the happy path.
- Prefer real pure collaborators and lightweight fakes at external boundaries
  over deep mocks of internal functions.

---

## 2. React

### 2.1 Follow the existing frontend boundaries

**Impact: HIGH**

- Pages in `client/src/pages/` compose route-level screens and coordinate page
  state.
  Move reusable visual sections to the owning feature directory rather than
  growing a page into a second application layer.
- Put feature-specific components under `client/src/components/<feature>/`;
  promote a primitive to `client/src/components/ui/` only when it is
  domain-agnostic and follows the shadcn registry workflow.
- Put a hook in `client/src/hooks/` only when multiple components use the
  stateful behavior. Keep a one-feature hook with its owner when a local
  directory already exists.
- Keep pure browser/domain logic out of components when it has meaningful tests
  or non-React callers; use `client/src/lib/` or the owning subsystem.

Do not impose Bulletproof React's TypeScript, feature folder, TanStack Query,
Zustand, React Hook Form, or Zod choices on this plain-JavaScript application.
Adopt its ownership and dependency-boundary principles, not its sample stack.

### 2.2 Keep components pure and meaningful

**Impact: CRITICAL**

- Components and hooks must be idempotent for the same props, state, and
  context. Do not mutate inputs or perform side effects during render.
- Use components through JSX; never call a component function directly or
  define a component inside another component.
- Give each component one recognizable UI responsibility. A component may own
  the markup, interaction state, and accessibility behavior for that concept;
  it need not wrap a single element or satisfy an arbitrary line limit.
- Prefer children, slots, and focused subcomponents over growing collections of
  boolean mode props. Avoid pass-through wrappers that add no semantics,
  behavior, styling contract, or reuse.
- Keep props minimal and explicit. Pass the data or callback the child needs,
  not an entire service object or page state by convenience.

### 2.3 Split components at real boundaries

**Impact: HIGH**

Extract a component when a section has its own responsibility, repeated use,
state lifecycle, error/loading boundary, accessibility contract, or measured
render cost. Keep small render fragments local when extraction would only create
prop plumbing or hide the reading order.

Pages should make screen structure and route-level states obvious. They may
coordinate feature hooks and compose major sections, but should not accumulate
low-level DOM behavior, unrelated transformations, or duplicated request logic.

### 2.4 Write hooks for stateful behavior

**Impact: CRITICAL**

- Call hooks only at the top level of React components or other hooks, before
  conditional returns.
- Extract a custom hook when components genuinely share stateful behavior or a
  complex external synchronization. Use an ordinary function for pure logic.
- Name custom hooks `useSomething`, keep their inputs and return value narrow,
  and return actions rather than exposing mutable internals.
- Keep every dependency array complete. Restructure unstable values instead of
  suppressing the hooks lint rule.
- Clean up timers, subscriptions, observers, and in-flight work. Setup and
  cleanup must remain correct when Strict Mode repeats them.

### 2.5 Keep state minimal and close

**Impact: CRITICAL**

- Store the minimum changing data. Derive filtered lists, counts, flags, labels,
  and other computable values during render instead of synchronizing duplicate
  state.
- Keep state in the closest component that owns it. Lift it only to the nearest
  common owner when siblings must coordinate; do not globalize state
  preemptively.
- Use URL state through the installed `nuqs` package when a filter, selection,
  tab, or view must survive refresh or be shareable.
- Use a reducer when several related transitions must preserve invariants. Use a
  ref for mutable values that do not affect rendering.
- Use functional state updates when the next value depends on the previous one,
  and lazy initialization for expensive initial calculations.
- Never mutate state or props. Preserve object identity for unchanged data when
  it matters to consumers.

### 2.6 Use effects only to synchronize external systems

**Impact: CRITICAL**

- Use an event handler for logic caused by an interaction. Use an effect only
  to synchronize with a network request, timer, subscription, browser API, or
  other system outside React.
- Do not use an effect to derive render data, copy props into state, or chain
  state changes that can happen in one event or calculation.
- Give each effect one synchronization responsibility with complete dependencies
  and symmetric cleanup.
- For asynchronous effects, prevent stale work from committing after inputs
  change or the component unmounts. Use `AbortController` when the API supports
  cancellation.

### 2.7 Handle page data explicitly

**Impact: HIGH**

- Follow the existing fetch and hook patterns; do not add a server-state library
  for one endpoint.
- Check response status, represent loading, error, empty, and success states,
  and make retry behavior an explicit user or lifecycle decision.
- Deduplicate a request abstraction only when multiple consumers share its URL,
  parsing, error semantics, and caching/invalidation behavior.
- Do not store request-specific data in mutable module globals or browser globals.

### 2.8 Preserve accessibility through primitives

**Impact: CRITICAL**

- Prefer semantic HTML before ARIA. Use real buttons and links, label controls,
  preserve keyboard behavior and visible focus, and provide text alternatives.
- Do not use a `div` click handler as a substitute for an interactive element.
  Give buttons an explicit `type` when form submission is not intended.
- Use the established Radix/shadcn primitives for dialogs, menus, tooltips,
  sheets, and other focus-sensitive interactions.
- Ensure loading, empty, error, disabled, and destructive states remain
  understandable without color alone. Respect reduced-motion preferences.

### 2.9 Optimize in impact order

**Impact: HIGH**

1. Eliminate waterfalls: start independent work together with `Promise.all`,
   defer `await` until its value is needed, and check cheap conditions before
   starting expensive work.
2. Protect bundle size: import from direct module paths, avoid new barrel files,
   and dynamically load only genuinely heavy, non-critical UI.
3. Reduce unnecessary work: calculate derived state during render, keep state
   subscriptions narrow, define components at module scope, and use stable keys
   from data rather than array indexes for reorderable lists.
4. Use lazy state initialization, transitions, deferred values, memoization, or
   component extraction only when the work is expensive or measurement shows a
   user-visible problem.
5. Apply micro-optimizations such as lookup maps, combined array passes, or
   cached computations only on hot or repeatedly traversed paths.

Do not wrap simple expressions or cheap components in `useMemo`, `useCallback`,
or `memo` by default. Correct ownership and data flow come before memoization.

### 2.10 Verify the user's experience

**Impact: HIGH**

- Test components through rendered behavior and user interactions rather than
  component internals.
- After UI changes, check the relevant page at its real localhost route, inspect
  browser errors and console output, and capture a screenshot when layout or
  visual state changed.
- Verify at least the loading/error or empty state affected by data-flow changes,
  not only the populated happy path.

---

## 3. Node.js

### 3.1 Organize by product capability and workflow

**Impact: HIGH**

- Keep `server/server.mjs` focused on hosting the cockpit, local APIs,
  synchronization, and composition of server-side services. Keep API, queue,
  and persistence modules under `server/`.
- Keep CLI parsing and run coordination in `analysis-worker/bin/prc.js`,
  `analysis-worker/cli.js`, and `analysis-worker/review-run.js`.
- Keep analysis code in its numbered `analysis-worker/workflow/` stage. Do not
  bypass validated stage contracts or duplicate workflow logic in the server.
- Keep deterministic review rendering and presentation models in
  `client/src/review/`. Apply these Node rules to `render.js` and other files in
  that directory when Node executes them.

Group new code by the capability it serves, not by generic `controllers`,
`services`, and `repositories` layers. Add a layer only when it creates a real
boundary used by multiple operations.

### 3.2 Keep entry points thin and domain logic testable

**Impact: HIGH**

- HTTP and CLI entry points should parse and validate input, call an owning
  operation, and translate its result to HTTP, console, or exit semantics.
- Separate policy and deterministic transformation from filesystem, GitHub,
  subprocess, clock, and network access when doing so creates a useful test seam.
- A service object is justified when it owns coordinated state and lifecycle,
  such as a queue, store, or worker. Do not create a service class around one
  stateless function.
- Inject expensive or nondeterministic boundaries where tests or alternate
  implementations need substitution. Keep stable native operations direct.
- Export only deliberate public entry points. Internal file layout is not a
  consumer API; avoid barrel modules that expose everything.

### 3.3 Validate every external boundary

**Impact: CRITICAL**

Treat HTTP bodies and parameters, CLI arguments, environment variables, config
files, GitHub responses, model output, persisted JSON, filesystem paths, and
subprocess output as untrusted.

- Validate type, shape, range, length, count, and allowed values before starting
  work or mutating state. Reject malformed input with a useful boundary-level
  error.
- Bound request bodies, arrays, output buffers, concurrency, and timeouts. Avoid
  unbounded work on the event loop.
- Resolve and verify filesystem containment before reading, writing, serving, or
  deleting a user-influenced path. Preserve atomic-write and restrictive-mode
  patterns for local state.
- Escape or sanitize untrusted content at an HTML or command boundary. Never use
  `eval`, construct a shell command from input, or dynamically import an
  unvalidated path.
- Do not return stack traces, local paths, command output, tokens, secrets, or
  internal error details to HTTP clients.

### 3.4 Treat subprocesses as a security and lifecycle boundary

**Impact: CRITICAL**

- Prefer `execFile` or `spawn` with an executable plus an argument array; do not
  enable a shell for user-influenced values.
- Validate URLs, identifiers, paths, models, and flags before passing them to a
  child process.
- Set appropriate timeouts and output limits, handle non-zero exits and spawn
  failures, and retain enough stderr context for diagnosis without leaking
  secrets.
- Propagate cancellation and terminate child process groups when an operation is
  cancelled or the service closes. Always clean up listeners and temporary
  resources.

### 3.5 Structure asynchronous work deliberately

**Impact: HIGH**

- Use promises and `async`/`await`; avoid callback pyramids and async Promise
  constructors.
- Run independent I/O concurrently, but keep dependent steps ordered. Limit
  concurrency when work consumes processes, memory, GitHub quota, or files.
- Await promises whose failures belong to the current operation so stacks and
  cleanup remain attached. Never leave a rejection floating.
- Avoid synchronous filesystem, process, or CPU-heavy work on request paths.
  Measure before introducing workers, caches, batching, or custom schedulers.
- Subscribe to the `error` path of event emitters and streams, and clear timers,
  listeners, and resources on every completion path.

### 3.6 Classify and handle errors at one boundary

**Impact: CRITICAL**

- Distinguish expected operational failures—invalid input, missing files,
  command failures, cancellation, unavailable services—from programmer errors
  and broken invariants.
- Handle an error only where the code can recover or translate it. Otherwise add
  relevant context and rethrow with `cause`.
- Centralize HTTP response mapping and top-level CLI reporting instead of
  repeating response/logging policy in every helper.
- Catch only the expected error code when applying a fallback, such as `ENOENT`.
  Re-throw unexpected failures.
- Make shutdown and `close()` paths idempotent. Stop accepting work, cancel or
  drain owned jobs as designed, then release timers, child processes, servers,
  locks, and temporary files.

### 3.7 Protect state and persistence

**Impact: CRITICAL**

- Do not keep request- or user-specific data in mutable module globals. Bound and
  invalidate process-wide caches explicitly.
- Validate persisted data again when loading it. Treat missing optional state
  differently from corrupt or inaccessible state.
- Write important state atomically with a temporary file plus rename and use
  restrictive permissions for user configuration.
- Preserve locking and single-writer invariants around queues and run history.
  Do not delete or overwrite completed review history unless the requested
  operation explicitly requires it.
- Make partial failure safe: write manifests and status transitions so an
  interrupted process can be diagnosed or recovered without pretending success.

### 3.8 Log for diagnosis, not storage

**Impact: MEDIUM**

- Include operation context such as review slug, run ID, batch ID, workflow
  stage, and external command when it helps connect events.
- Log errors with enough context to act, once at the boundary that owns reporting.
  Do not log full diffs, prompts, environment objects, credentials, auth headers,
  or other sensitive payloads.
- Use stdout/stderr so the process owner controls destinations. Do not add a
  logging dependency until structured levels, sinks, or correlation needs exceed
  the native console.

### 3.9 Test Node.js at the component boundary

**Impact: HIGH**

- Use the existing `node:test` suites. Name new tests `*.test.js` or
  `*.test.mjs`; run one directly with `node --test --test-concurrency=1 <path>`
  and run the full suite with `pnpm test`.
- Prefer API, service, workflow-stage, renderer, and persistence tests that
  exercise a meaningful operation over isolated tests for every private helper.
- Use temporary directories and random test ports. Create data per test and
  clean up processes, timers, files, and servers even when an assertion fails.
- Substitute GitHub, model, clock, and process boundaries with small fakes while
  keeping the owning service or workflow real.
- Cover validation failure, external-command failure, cancellation, interrupted
  persistence, and restart/reload behavior when the change touches those risks.
