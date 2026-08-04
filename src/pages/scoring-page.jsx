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
import { useDocumentTitle } from "@/hooks/use-document-title.js";
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
    <Table className="min-w-[52rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="h-auto bg-secondary/55 px-5 py-3 text-[0.64rem] font-extrabold uppercase tracking-[0.09em] text-muted-foreground" scope="col">Situation</TableHead>
          <TableHead className="h-auto bg-secondary/55 px-5 py-3 text-[0.64rem] font-extrabold uppercase tracking-[0.09em] text-muted-foreground" scope="col">Base</TableHead>
          <TableHead className="h-auto bg-secondary/55 px-5 py-3 text-[0.64rem] font-extrabold uppercase tracking-[0.09em] text-muted-foreground" scope="col">Signals</TableHead>
          <TableHead className="h-auto bg-secondary/55 px-5 py-3 text-[0.64rem] font-extrabold uppercase tracking-[0.09em] text-muted-foreground" scope="col">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...scenarios]
          .sort((a, b) => total(base, b[1]) - total(base, a[1]))
          .map(([label, signals]) => (
            <TableRow key={label}>
              <TableHead className="w-72 px-5 py-3 text-[0.78rem] font-bold" scope="row">{label}</TableHead>
              <TableCell className="w-20 px-5 py-3 text-[0.76rem] leading-normal text-foreground tabular-nums">{signedScore(base)}</TableCell>
              <TableCell className="px-5 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {signals.length
                    ? signals.map((signal) => (
                        <Badge key={signal} variant="secondary">{signal} {signedScore(signalScores.get(signal))}</Badge>
                      ))
                    : <Badge variant="secondary">None</Badge>}
                </div>
              </TableCell>
              <TableCell className="w-20 px-5 py-3"><Badge variant="outline">{signedScore(total(base, signals))}</Badge></TableCell>
            </TableRow>
          ))}
      </TableBody>
    </Table>
  );
}

export function ScoringPage() {
  useDocumentTitle({ title: "Scoring Model · PR Review Cockpit" });
  return (
    <main className="min-h-screen">
      <div className="mx-auto w-[min(100%-2.5rem,68rem)] pt-12 pb-20 max-[700px]:w-[min(100%-1.5rem,68rem)] max-[700px]:pt-6">
        <div className="flex items-center justify-between">
          <a className="inline-flex items-center gap-[0.45rem] text-[0.78rem] font-bold text-muted-foreground no-underline hover:text-foreground" href="/">
            <ArrowLeft className="size-4" />
            Back to the queue
          </a>
          <ThemeToggle />
        </div>

        <header className="mt-10">
          <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-primary"><span className="size-1.5 rounded-full bg-primary" />Priority model</p>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">How scoring works</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every pull request gets one lifecycle base. Unique activity signals are then added on
            top; each signal type counts once per PR.
          </p>
        </header>

        <div className="my-8 flex flex-wrap items-center gap-[0.65rem] rounded-[0.9rem] border border-primary/22 bg-primary/7 px-5 py-4 text-[0.82rem] text-muted-foreground" aria-label="Scoring formula">
          <strong className="text-foreground">Total priority</strong><span>=</span><span>lifecycle base</span><span>+</span><span>activity signals</span>
        </div>

        {scenarioGroups.map(({ lifecycle, base, description, scenarios }) => (
          <section className="mt-4 overflow-hidden rounded-lg border bg-card/82 shadow-lg backdrop-blur" aria-labelledby={sectionId(lifecycle)} key={lifecycle}>
            <header className="flex items-end justify-between gap-4 border-b px-5 py-4 max-[700px]:block">
              <div>
                <p className="mb-1 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-primary">Lifecycle · base {signedScore(base)}</p>
                <h2 className="m-0 font-display text-[1.35rem] font-[650]" id={sectionId(lifecycle)}>{lifecycle}</h2>
              </div>
              <p className="m-0 text-[0.72rem] text-muted-foreground max-[700px]:mt-[0.35rem]">{description}</p>
            </header>
            <ScenarioTable base={base} scenarios={scenarios} />
          </section>
        ))}

        <p className="mt-4 rounded-sm border bg-card/65 px-5 py-3 text-[0.7rem] leading-[1.6] text-muted-foreground">
          Direct and team review requests share one slot; direct wins. All other signals remain
          additive, so any unlisted valid combination uses the same formula.
        </p>
        <p className="mt-4 text-[0.72rem] leading-[1.6] text-muted-foreground">
          Queue membership and Done state are local. Reading a GitHub notification does not remove
          or reopen a pull request.
        </p>
      </div>
    </main>
  );
}
