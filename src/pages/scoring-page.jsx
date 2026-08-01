import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.jsx";
import { signedScore } from "@/lib/queue.js";

const signalScores = new Map([
  ["Direct review request", 10],
  ["Comment after merge", 10],
  ["Teammate authored PR", 7],
  ["Reply to your review", 6],
  ["New commits", 3],
  ["Team review request", 3],
  ["New comments", 2],
  ["Covered by teammate", -4],
]);

const scenarioGroups = [
  {
    lifecycle: "Reviewed",
    base: 10,
    description: "You commented or requested changes in your latest review.",
    scenarios: [
      ["Re-requested teammate PR with reply and commits", ["Direct review request", "Teammate authored PR", "Reply to your review", "New commits"]],
      ["Teammate PR with a reply and new commits", ["Teammate authored PR", "Reply to your review", "New commits"]],
      ["Reply and new commits", ["Reply to your review", "New commits"]],
      ["No fresh activity", []],
    ],
  },
  {
    lifecycle: "New / unreviewed",
    base: 0,
    description: "A priority signal exists, but you have not reviewed the PR.",
    scenarios: [
      ["Teammate PR requesting you directly", ["Direct review request", "Teammate authored PR"]],
      ["New teammate PR requesting you", ["Direct review request", "Teammate authored PR"]],
      ["Direct review request", ["Direct review request"]],
      ["Team request already covered by a teammate", ["Team review request", "Covered by teammate"]],
    ],
  },
  {
    lifecycle: "My pull request",
    base: 0,
    description: "You authored the open PR.",
    scenarios: [["Open pull request", []]],
  },
  {
    lifecycle: "Approved",
    base: -5,
    description: "Your latest review approved the PR.",
    scenarios: [
      ["Re-requested teammate PR with reply and commits", ["Direct review request", "Teammate authored PR", "Reply to your review", "New commits"]],
      ["Directly re-requested with a reply", ["Direct review request", "Reply to your review"]],
      ["Directly re-requested", ["Direct review request"]],
      ["No fresh activity", []],
    ],
  },
  {
    lifecycle: "Merged",
    base: -5,
    description: "The PR is merged.",
    scenarios: [
      ["Comment after merge", ["Comment after merge"]],
      ["No post-merge activity", []],
    ],
  },
  {
    lifecycle: "Draft",
    base: -10,
    description: "The PR is still a draft.",
    scenarios: [
      ["Re-requested teammate PR with reply and commits", ["Direct review request", "Teammate authored PR", "Reply to your review", "New commits"]],
      ["New teammate PR requesting you", ["Direct review request", "Teammate authored PR"]],
      ["Direct review request", ["Direct review request"]],
      ["No fresh activity", []],
    ],
  },
].sort((a, b) => b.base - a.base);

function total(base, signals) {
  return base + signals.reduce((sum, signal) => sum + signalScores.get(signal), 0);
}

function sectionId(value) {
  return `scoring-${value.toLowerCase().replace(/\W+/g, "-")}`;
}

function ScenarioTable({ base, scenarios }) {
  return (
    <Table className="scoring-table scoring-scenarios">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Situation</TableHead>
          <TableHead scope="col">Base</TableHead>
          <TableHead scope="col">Signals</TableHead>
          <TableHead scope="col">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...scenarios]
          .sort((a, b) => total(base, b[1]) - total(base, a[1]))
          .map(([label, signals]) => (
            <TableRow key={label}>
              <TableHead scope="row">{label}</TableHead>
              <TableCell>{signedScore(base)}</TableCell>
              <TableCell>
                <div className="scenario-signals">
                  {signals.length
                    ? signals.map((signal) => <span key={signal}>{signal} {signedScore(signalScores.get(signal))}</span>)
                    : <span>None</span>}
                </div>
              </TableCell>
              <TableCell><Badge variant="outline">{signedScore(total(base, signals))}</Badge></TableCell>
            </TableRow>
          ))}
      </TableBody>
    </Table>
  );
}

export function ScoringPage() {
  return (
    <main className="app-canvas min-h-screen">
      <div className="scoring-page">
        <div className="flex items-center justify-between">
          <a className="scoring-back" href="/">
            <ArrowLeft className="size-4" />
            Back to the queue
          </a>
          <ThemeToggle />
        </div>

        <header className="mt-10">
          <p className="eyebrow"><span className="size-1.5 rounded-full bg-primary" />Priority model</p>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">How scoring works</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every pull request gets one lifecycle base. Unique activity signals are then added on
            top; each signal type counts once per PR.
          </p>
        </header>

        <div className="scoring-formula" aria-label="Scoring formula">
          <strong>Total priority</strong><span>=</span><span>lifecycle base</span><span>+</span><span>activity signals</span>
        </div>

        {scenarioGroups.map(({ lifecycle, base, description, scenarios }) => (
          <section className="scoring-sheet" aria-labelledby={sectionId(lifecycle)} key={lifecycle}>
            <header>
              <div>
                <p className="eyebrow">Lifecycle · base {signedScore(base)}</p>
                <h2 id={sectionId(lifecycle)}>{lifecycle}</h2>
              </div>
              <p>{description}</p>
            </header>
            <ScenarioTable base={base} scenarios={scenarios} />
          </section>
        ))}

        <p className="scoring-table-note scoring-page-note">
          Direct and team review requests share one slot; direct wins. All other signals remain
          additive, so any unlisted valid combination uses the same formula.
        </p>
        <p className="scoring-footnote">
          Queue membership and Done state are local. Reading a GitHub notification does not remove
          or reopen a pull request.
        </p>
      </div>
    </main>
  );
}
