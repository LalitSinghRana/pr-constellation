import { AnalysisAgentStatusDialog } from "@/components/review-queue/analysis-agent-status-dialog.jsx";
import { AnalysisPage } from "@/pages/analysis-page.jsx";
import { QueuePage } from "@/pages/queue-page.jsx";
import { ReviewPage } from "@/pages/review-page.jsx";
import { SettingsPage } from "@/pages/settings-page.jsx";

export default function App() {
  const pathname = window.location.pathname;
  const page = pathname.startsWith("/reviews/") ? (
    <ReviewPage />
  ) : pathname.startsWith("/analysis") ? (
    <AnalysisPage />
  ) : pathname.startsWith("/scoring") || pathname.startsWith("/settings") ? (
    <SettingsPage />
  ) : (
    <QueuePage />
  );

  return (
    <>
      {page}
      {pathname.startsWith("/reviews/") ? null : <AnalysisAgentStatusDialog />}
    </>
  );
}
