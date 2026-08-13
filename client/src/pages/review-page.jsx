import { useEffect, useMemo, useState } from "react";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { readJson, useQuery } from "@/hooks/use-query.js";
import { buildReviewData, buildReviewTreeData } from "@/review/build-review-tree-data.js";
import { readReviewRunId, readReviewSlug } from "@/review/review-tree/state.js";
import { ReviewTreeApp } from "@/review/review-tree-app.jsx";
import { getSyntaxHighlighter, languagesForFilePaths } from "@/review/shiki-highlighter.js";
import "@xyflow/react/dist/style.css";
import "@git-diff-view/react/styles/diff-view.css";
import "@/review/styles.css";

export function ReviewPage() {
  const slug = readReviewSlug();
  const runId = readReviewRunId();
  const payloadUrl = runId
    ? `/api/reviews/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`
    : `/api/reviews/${encodeURIComponent(slug)}`;

  const payloadQuery = useQuery({
    enabled: Boolean(slug),
    queryFn: async ({ signal }) => {
      const response = await fetch(payloadUrl, { signal });
      return readJson(response);
    },
    queryKey: ["review-payload", slug, runId || "latest"],
  });

  const [presentation, setPresentation] = useState({
    error: undefined,
    review: undefined,
    status: "idle",
    treeData: undefined,
  });

  useEffect(() => {
    if (payloadQuery.status !== "success" || !payloadQuery.data) {
      setPresentation({
        error: undefined,
        review: undefined,
        status: payloadQuery.status === "pending" ? "pending" : "idle",
        treeData: undefined,
      });
      return;
    }

    let canceled = false;
    setPresentation((current) => ({
      ...current,
      error: undefined,
      status: "pending",
    }));

    (async () => {
      try {
        const { analysis, diffInventory, metadata } = payloadQuery.data;
        const languages = languagesForFilePaths((analysis.files || []).map((file) => file.path));
        const syntaxHighlighter = await getSyntaxHighlighter(languages);
        if (canceled) return;
        const treeData = buildReviewTreeData({ analysis, diffInventory, syntaxHighlighter });
        const review = buildReviewData({ pr: metadata });
        if (canceled) return;
        setPresentation({
          error: undefined,
          review,
          status: "success",
          treeData,
        });
      } catch (error) {
        if (canceled) return;
        setPresentation({
          error: error instanceof Error ? error : new Error(String(error)),
          review: undefined,
          status: "error",
          treeData: undefined,
        });
      }
    })();

    return () => {
      canceled = true;
    };
  }, [payloadQuery.data, payloadQuery.status]);

  const title = useMemo(() => {
    const review = presentation.review;
    if (!review?.title) return "Review · PR Review Cockpit";
    return `${review.title} · PR #${review.number} · PR Review Cockpit`;
  }, [presentation.review]);

  useDocumentTitle({ title });

  if (!slug) {
    return (
      <ReviewStatusMessage title="Review not found" detail="Missing review slug in the URL." />
    );
  }

  if (payloadQuery.status === "pending" || presentation.status === "pending") {
    return (
      <ReviewStatusMessage
        title="Loading review…"
        detail="Fetching analysis and highlighting diffs."
      />
    );
  }

  if (payloadQuery.status === "error") {
    return (
      <ReviewStatusMessage
        title="Review unavailable"
        detail={payloadQuery.error?.message || "The review could not be loaded."}
      />
    );
  }

  if (presentation.status === "error") {
    return (
      <ReviewStatusMessage
        title="Review unavailable"
        detail={presentation.error?.message || "The review could not be prepared."}
      />
    );
  }

  if (presentation.status !== "success" || !presentation.review || !presentation.treeData) {
    return (
      <ReviewStatusMessage
        title="Review unavailable"
        detail="No analysis is available for this review."
      />
    );
  }

  return (
    <ReviewTreeApp
      review={presentation.review}
      reviewSlug={slug}
      treeData={presentation.treeData}
    />
  );
}

function ReviewStatusMessage({ title, detail }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </main>
  );
}
