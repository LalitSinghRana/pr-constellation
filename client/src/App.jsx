import { AnalysisAgentStatusDialog } from "@/components/review-queue/analysis-agent-status-dialog.jsx";
import { AnalysisPage } from "@/pages/analysis-page.jsx";
import { QueuePage } from "@/pages/queue-page.jsx";
import { ScoringPage } from "@/pages/scoring-page.jsx";
import { SettingsPage } from "@/pages/settings-page.jsx";

export default function App() {
  const page = window.location.pathname.startsWith("/analysis") ? (
    <AnalysisPage />
  ) : window.location.pathname.startsWith("/scoring") ? (
    <ScoringPage />
  ) : window.location.pathname.startsWith("/settings") ? (
    <SettingsPage />
  ) : (
    <QueuePage />
  );

  return (
    <>
      {page}
      <AnalysisAgentStatusDialog />
    </>
  );
}
