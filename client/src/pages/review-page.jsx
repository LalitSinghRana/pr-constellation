import { useEffect, useState } from "react";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { readJson, useQuery } from "@/hooks/use-query.js";
import { buildReviewData, buildReviewTreeData } from "@/review/build-review-tree-data.js";
import { readReviewRunId, readReviewSlug } from "@/review/review-tree/state.js";
import { ReviewTreeApp } from "@/review/review-tree-app.jsx";
import { getSyntaxHighlighter, languagesForFilePaths } from "@/review/shiki-highlighter.js";
import "@xyflow/react/dist/style.css";
import "@git-diff-view/react/styles/diff-view.css";

export function ReviewPage() {
  const slug = readReviewSlug();
  const runId = readReviewRunId();
  const payloadUrl = runId
    ? `/api/reviews/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`
    : `/api/reviews/${encodeURIComponent(slug)}`;

  const contextQuery = useQuery({
    enabled: Boolean(slug),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/reviews/${encodeURIComponent(slug)}/context`, { signal });
      return readJson(response);
    },
    queryKey: ["review-context", slug],
  });

  const analysisStatus = contextQuery.data?.analysis?.status;
  const payloadEnabled = Boolean(slug) && (Boolean(runId) || analysisStatus === "succeeded");
  const payloadQuery = useQuery({
    enabled: payloadEnabled,
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
    const events = new EventSource("/api/events");
    const refreshSoon = () => {
      void contextQuery.refetch();
      if (payloadEnabled) void payloadQuery.refetch();
    };
    events.addEventListener("analysis", refreshSoon);
    events.addEventListener("ready", refreshSoon);
    return () => events.close();
  }, [contextQuery.refetch, payloadEnabled, payloadQuery.refetch]);

  useEffect(() => {
    if (!payloadEnabled) {
      setPresentation({
        error: undefined,
        review: undefined,
        status: "idle",
        treeData: undefined,
      });
      return;
    }
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
  }, [payloadEnabled, payloadQuery.data, payloadQuery.status]);

  const analyzeMutation = useMutation({
    mutationFn: async (prUrl) => {
      const response = await fetch("/api/runs", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ prUrl }),
      });
      return readJson(response);
    },
    onSuccess: () => {
      void contextQuery.refetch();
    },
  });

  const review = presentation.review || contextQuery.data?.review;
  const title = review?.title
    ? `${review.title} · PR #${review.number} · PR Constellation`
    : "Review · PR Constellation";

  useDocumentTitle({ title });

  if (!slug) {
    return (
      <ReviewStatusMessage title="Review not found" detail="Missing review slug in the URL." />
    );
  }

  if (contextQuery.status === "pending") {
    return <ReviewStatusMessage title="Loading review…" detail="Fetching pull request details." />;
  }

  if (contextQuery.status === "error" || !review) {
    return (
      <ReviewStatusMessage
        title="Review unavailable"
        detail={contextQuery.error?.message || "The review could not be loaded."}
      />
    );
  }

  if (payloadEnabled && payloadQuery.status === "error") {
    return (
      <ReviewStatusMessage
        title="Review unavailable"
        detail={payloadQuery.error?.message || "The review could not be loaded."}
      />
    );
  }

  if (payloadEnabled && payloadQuery.status === "pending" && presentation.status !== "success") {
    return (
      <ReviewStatusMessage
        title="Loading review…"
        detail="Fetching analysis and highlighting diffs."
      />
    );
  }

  return (
    <ReviewTreeApp
      analysisBusy={analyzeMutation.isPending}
      analysisStatus={analysisStatus}
      onAnalyze={() => analyzeMutation.mutate(review.url)}
      review={review}
      reviewSlug={slug}
      treeData={presentation.status === "success" ? presentation.treeData : undefined}
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
