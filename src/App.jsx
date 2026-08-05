import { AnalysisPage } from "@/pages/analysis-page.jsx";
import { FixturesPage } from "@/pages/fixtures-page.jsx";
import { QueuePage } from "@/pages/queue-page.jsx";
import { ScoringPage } from "@/pages/scoring-page.jsx";

export default function App() {
  if (window.location.pathname.startsWith("/analysis")) return <AnalysisPage />;
  if (window.location.pathname.startsWith("/scoring")) return <ScoringPage />;
  if (window.location.pathname.startsWith("/fixtures")) return <FixturesPage />;
  return <QueuePage />;
}
