import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AnalysisAgentSettings,
  useAnalysisCatalog,
} from "@/components/settings/analysis-agent-settings.jsx";
import { ScoringCard } from "@/components/settings/scoring-card.jsx";
import { TeamSettingsForm } from "@/components/settings/team-settings-form.jsx";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import { Collapsible } from "@/components/ui/collapsible.jsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item.jsx";
import { Label } from "@/components/ui/label.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { putSettings, useSettingsQuery } from "@/hooks/use-settings.js";
import { useTheme } from "@/hooks/use-theme.js";
import { EMPTY_SETTINGS } from "@/lib/queue.js";
import { THEME_MODES } from "@/lib/theme.js";
import {
  applyReviewUiSettings,
  REVIEW_TREE_DENSITY_MODES,
} from "../../../shared/review-ui-settings.js";

function sectionFromLocation() {
  if (window.location.pathname.startsWith("/scoring")) return "scoring";
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "team" || hash === "scoring" ? hash : "";
}

const TREE_NAVIGATION_SHORTCUTS = [
  { action: "Previous review node", keys: ["←"] },
  { action: "Next review node", keys: ["→"] },
  { action: "Previous file", keys: ["Shift", "←"] },
  { action: "Next file", keys: ["Shift", "→"] },
];

export function SettingsPage() {
  useDocumentTitle({ title: "Settings · PR Review Cockpit" });
  const settingsQuery = useSettingsQuery();
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [teamOpen, setTeamOpen] = useState(() => sectionFromLocation() === "team");
  const [scoringOpen, setScoringOpen] = useState(() => sectionFromLocation() === "scoring");
  const saveSettings = useMutation({
    mutationFn: putSettings,
  });

  useEffect(() => {
    if (settingsQuery.data) setSettings(applyReviewUiSettings(settingsQuery.data));
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!window.location.pathname.startsWith("/scoring")) return;
    window.history.replaceState(null, "", "/settings#scoring");
  }, []);

  async function patchSettings(patch) {
    if (settingsQuery.isLoading || saveSettings.isPending) return false;
    const previous = settings;
    const body = { ...settings, ...patch };
    setSettings(body);
    try {
      const result = await saveSettings.mutateAsync(body);
      setSettings(result);
      return true;
    } catch {
      setSettings(previous);
      return false;
    }
  }

  function setSectionOpen(section, nextOpen) {
    if (section === "team") setTeamOpen(nextOpen);
    else setScoringOpen(nextOpen);
    const otherOpen = section === "team" ? scoringOpen : teamOpen;
    if (nextOpen) {
      window.history.replaceState(null, "", `/settings#${section}`);
      return;
    }
    if (window.location.hash !== `#${section}`) return;
    window.history.replaceState(
      null,
      "",
      otherOpen ? `/settings#${section === "team" ? "scoring" : "team"}` : "/settings",
    );
  }

  const error =
    (saveSettings.isError && (saveSettings.error?.message || "Setting could not be saved.")) ||
    settingsQuery.error?.message ||
    "";
  const busy = settingsQuery.isLoading || saveSettings.isPending;
  const analysisCatalog = useAnalysisCatalog();
  const { mode: themeMode, setTheme } = useTheme();

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1240px] px-5 pt-12 pb-20 sm:px-8 max-[700px]:px-4 max-[700px]:pt-6">
        <div className="flex items-center justify-between">
          <a
            className="inline-flex items-center gap-[0.45rem] text-[0.78rem] font-bold text-muted-foreground no-underline hover:text-foreground"
            href="/"
          >
            <ArrowLeft className="size-4" />
            Back to the inbox
          </a>
          <ThemeToggle />
        </div>

        <header className="mt-10">
          <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-primary">
            <span className="size-1.5 rounded-full bg-primary" />
            Preferences
          </p>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
            Settings
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Turn cockpit features on or off, configure the team used to score the inbox, and inspect
            the priority model. Preferences are saved in the local SQLite settings store.
          </p>
        </header>

        {error ? (
          <p
            className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <section className="mt-8" aria-labelledby="feature-toggles-heading">
          <h2 className="sr-only" id="feature-toggles-heading">
            Feature toggles
          </h2>
          <ItemGroup className="gap-0 overflow-hidden rounded-lg border bg-card/82 shadow-lg backdrop-blur">
            <Item size="sm" className="items-start rounded-none border-0 px-5 py-4 max-sm:flex-col">
              <ItemContent>
                <ItemTitle>
                  <Label>Default analysis</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Provider, model, and effort used for Analyze, Retry, and auto-queue. Cursor Agent
                  runs Composer and Grok; GPT models use Codex; Claude models use Claude.
                </ItemDescription>
              </ItemContent>
              <ItemActions className="max-sm:w-full max-sm:justify-stretch">
                <AnalysisAgentSettings
                  busy={busy}
                  catalog={analysisCatalog}
                  onSave={(patch) => patchSettings(patch)}
                  settings={settings}
                />
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="rounded-none border-0 px-5 py-4">
              <ItemContent>
                <ItemTitle>
                  <Label htmlFor="auto-queue">Auto queue</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  When enabled, first-time unreviewed pull requests are queued for AI analysis on
                  each sync. Re-runs must be started manually.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  id="auto-queue"
                  checked={settings.autoQueue === true}
                  disabled={busy}
                  onCheckedChange={(enabled) => patchSettings({ autoQueue: enabled })}
                />
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="rounded-none border-0 px-5 py-4">
              <ItemContent>
                <ItemTitle>
                  <Label htmlFor="show-minimap">Mini-map</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Show the overview map on review tree pages so you can jump between nodes.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  id="show-minimap"
                  checked={settings.showMinimap === true}
                  disabled={busy}
                  onCheckedChange={(enabled) => patchSettings({ showMinimap: enabled })}
                />
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="items-start rounded-none border-0 px-5 py-4 max-sm:flex-col">
              <ItemContent>
                <ItemTitle>
                  <Label>Review tree density</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Default folding on Review trees. 0.1x keeps primary runtime, 1x adds secondary
                  runtime, and 10x shows every section.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Tabs
                  onValueChange={(reviewTreeDensity) => patchSettings({ reviewTreeDensity })}
                  value={settings.reviewTreeDensity}
                >
                  <TabsList aria-label="Default review tree density">
                    {REVIEW_TREE_DENSITY_MODES.map((mode) => (
                      <TabsTrigger disabled={busy} key={mode} value={mode}>
                        {mode}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="items-start rounded-none border-0 px-5 py-4 max-sm:flex-col">
              <ItemContent>
                <ItemTitle>
                  <Label>Default review tab</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Which pane opens first on a generated review page.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Tabs
                  onValueChange={(defaultReviewTab) => patchSettings({ defaultReviewTab })}
                  value={settings.defaultReviewTab}
                >
                  <TabsList aria-label="Default review tab">
                    <TabsTrigger disabled={busy} value="conversation">
                      Conversation
                    </TabsTrigger>
                    <TabsTrigger disabled={busy} value="trees">
                      Review trees
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="items-start rounded-none border-0 px-5 py-4 max-sm:flex-col">
              <ItemContent>
                <ItemTitle>
                  <Label>Appearance</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Light, dark, or follow the operating system. The sidebar sun and moon control
                  still switches between light and dark.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Tabs onValueChange={setTheme} value={themeMode}>
                  <TabsList aria-label="Color theme">
                    {THEME_MODES.map((mode) => (
                      <TabsTrigger className="capitalize" key={mode} value={mode}>
                        {mode}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="items-start rounded-none border-0 px-5 py-4 max-sm:flex-col">
              <ItemContent>
                <ItemTitle>Tree navigation</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Keyboard shortcuts on Review trees. These shortcuts cannot be changed.
                </ItemDescription>
              </ItemContent>
              <ItemActions className="max-sm:w-full">
                <ul className="pointer-events-none grid gap-2 text-sm text-muted-foreground">
                  {TREE_NAVIGATION_SHORTCUTS.map((shortcut) => (
                    <li className="flex items-center justify-end gap-3" key={shortcut.action}>
                      <span>{shortcut.action}</span>
                      <span className="flex items-center gap-1">
                        {shortcut.keys.map((key) => (
                          <kbd
                            className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                            key={key}
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Collapsible
              open={teamOpen}
              onOpenChange={(nextOpen) => setSectionOpen("team", nextOpen)}
            >
              <Item size="sm" className="flex-col items-stretch rounded-none border-0 px-0 py-0">
                <div className="flex w-full items-center gap-4 px-5 py-4">
                  <ItemContent>
                    <ItemTitle>Team</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      GitHub username, teammates, and teams used to score the inbox.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Item.Trigger aria-label="Show team settings" id="team" />
                  </ItemActions>
                </div>
                <Item.Panel>
                  <div className="border-t px-5 py-4">
                    <TeamSettingsForm
                      busy={busy}
                      onSave={(patch) => patchSettings(patch)}
                      settings={settings}
                    />
                  </div>
                </Item.Panel>
              </Item>
            </Collapsible>
            <ItemSeparator />
            <Collapsible
              open={scoringOpen}
              onOpenChange={(nextOpen) => setSectionOpen("scoring", nextOpen)}
            >
              <Item size="sm" className="flex-col items-stretch rounded-none border-0 px-0 py-0">
                <div className="flex w-full items-center gap-4 px-5 py-4">
                  <ItemContent>
                    <ItemTitle>Scoring model</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      Lifecycle bases and activity signals that make a pull request's priority
                      score.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Item.Trigger aria-label="Show scoring model" id="scoring" />
                  </ItemActions>
                </div>
                <Item.Panel>
                  <div className="border-t px-5 py-4">
                    <ScoringCard />
                  </div>
                </Item.Panel>
              </Item>
            </Collapsible>
          </ItemGroup>
        </section>
      </div>
    </main>
  );
}
