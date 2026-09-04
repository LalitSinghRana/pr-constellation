import { signedScore } from "@/lib/queue.js";
import { SCORING_LIFECYCLE_BARS, SCORING_SIGNAL_BARS, scoreBarLayout } from "@/lib/scoring.js";

function ScoreChart({ items, title }) {
  const maxAbs = Math.max(...items.map((item) => Math.abs(item.score)), 1);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 text-[0.64rem] font-extrabold uppercase tracking-[0.09em] text-muted-foreground">
        {title}
      </figcaption>
      <ul className="grid gap-2.5">
        {items.map((item) => {
          const layout = scoreBarLayout(item.score, maxAbs);
          return (
            <li
              className="grid grid-cols-[minmax(0,9.5rem)_1fr_2.75rem] items-center gap-3"
              key={item.id}
            >
              <span className="truncate text-[0.78rem] font-medium" title={item.label}>
                {item.label}
              </span>
              <div
                aria-hidden="true"
                className="relative h-2 overflow-hidden rounded-full bg-muted"
              >
                <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <span
                  className={
                    layout.negative
                      ? "absolute top-0 h-full rounded-full bg-error"
                      : "absolute top-0 h-full rounded-full bg-primary"
                  }
                  style={{ left: `${layout.offsetPercent}%`, width: `${layout.widthPercent}%` }}
                />
              </div>
              <span className="text-right text-[0.76rem] tabular-nums text-muted-foreground">
                {signedScore(item.score)}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

export function ScoringCard() {
  return (
    <div className="grid gap-6">
      <p className="m-0 text-sm leading-6 text-muted-foreground">
        Total priority = lifecycle base + unique activity signals. Direct and team review requests
        share one slot; direct wins.
      </p>
      <div className="grid gap-8 sm:grid-cols-2">
        <ScoreChart items={SCORING_LIFECYCLE_BARS} title="Lifecycle bases" />
        <ScoreChart items={SCORING_SIGNAL_BARS} title="Activity signals" />
      </div>
    </div>
  );
}
