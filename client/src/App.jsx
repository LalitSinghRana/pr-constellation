import { AnalysisPage } from "@/pages/analysis-page.jsx";
import { QueuePage } from "@/pages/queue-page.jsx";
import { ScoringPage } from "@/pages/scoring-page.jsx";
import { SettingsPage } from "@/pages/settings-page.jsx";

export default function App() {
  if (window.location.pathname.startsWith("/analysis")) return <AnalysisPage />;
  if (window.location.pathname.startsWith("/scoring")) return <ScoringPage />;
  if (window.location.pathname.startsWith("/settings")) return <SettingsPage />;
  return <QueuePage />;
}
