import { AnalysisAgentStatusDialog } from "@/components/analysis-agent-status-dialog.jsx";
import { Toaster } from "@/components/ui/sonner.jsx";
import { AnalysisPage } from "@/pages/analysis/analysis-page.jsx";
import { InboxPage } from "@/pages/inbox/inbox-page.jsx";
import { ReviewPage } from "@/pages/review-page.jsx";
import { SettingsPage } from "@/pages/settings/settings-page.jsx";

export default function App() {
  const pathname = window.location.pathname;
  const page = pathname.startsWith("/reviews/") ? (
    <ReviewPage />
  ) : pathname.startsWith("/analysis") ? (
    <AnalysisPage />
  ) : pathname.startsWith("/scoring") || pathname.startsWith("/settings") ? (
    <SettingsPage />
  ) : (
    <InboxPage />
  );

  return (
    <>
      {page}
      <Toaster position="top-right" />
      {pathname.startsWith("/reviews/") ? null : <AnalysisAgentStatusDialog />}
    </>
  );
}
