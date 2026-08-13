import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { ScoringCard } from "@/components/settings/scoring-card.jsx";
import { SettingsExpandableRow } from "@/components/settings/settings-expandable-row.jsx";
import { TeamSettingsForm } from "@/components/settings/team-settings-form.jsx";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { putSettings, useSettingsQuery } from "@/hooks/use-settings.js";
import { EMPTY_SETTINGS } from "@/lib/queue.js";
import {
  DEFAULT_ANALYSIS_MODEL,
  SETTINGS_ANALYSIS_AGENTS,
} from "../../../shared/analysis-models.js";

function sectionFromLocation() {
  if (window.location.pathname.startsWith("/scoring")) return "scoring";
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "team" || hash === "scoring" ? hash : "";
}

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
    if (settingsQuery.data) setSettings(settingsQuery.data);
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
  const defaultAnalysisModel = settings.defaultAnalysisModel || DEFAULT_ANALYSIS_MODEL;

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1240px] px-5 pt-12 pb-20 sm:px-8 max-[700px]:px-4 max-[700px]:pt-6">
        <div className="flex items-center justify-between">
          <a
            className="inline-flex items-center gap-[0.45rem] text-[0.78rem] font-bold text-muted-foreground no-underline hover:text-foreground"
            href="/"
          >
            <ArrowLeft className="size-4" />
            Back to the queue
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
            Turn cockpit features on or off, configure the team used to score the queue, and inspect
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
            <Item size="sm" className="rounded-none border-0 px-5 py-4">
              <ItemContent>
                <ItemTitle>
                  <Label htmlFor="default-agent">Default agent</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Used for Analyze, Retry, and auto-queue.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Select
                  value={defaultAnalysisModel}
                  disabled={busy}
                  onValueChange={(value) => patchSettings({ defaultAnalysisModel: value })}
                >
                  <SelectTrigger
                    id="default-agent"
                    className="w-[11.5rem]"
                    aria-label="Default agent"
                  >
                    <SelectValue placeholder="Select agent" />
                  </SelectTrigger>
                  <SelectContent align="end" position="popper">
                    {SETTINGS_ANALYSIS_AGENTS.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.label} {agent.providerLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="rounded-none border-0 px-5 py-4">
              <ItemContent>
                <ItemTitle>
                  <Label htmlFor="auto-queue">Auto queue</Label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  When enabled, unreviewed pull requests are queued for AI analysis immediately and
                  kept topped up on each sync.
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
            <SettingsExpandableRow
              description="GitHub username, teammates, and teams used to score the queue."
              id="team"
              onOpenChange={(nextOpen) => setSectionOpen("team", nextOpen)}
              open={teamOpen}
              title="Team"
            >
              <TeamSettingsForm
                busy={busy}
                onSave={(patch) => patchSettings(patch)}
                settings={settings}
              />
            </SettingsExpandableRow>
            <ItemSeparator />
            <SettingsExpandableRow
              description="Lifecycle bases and activity signals that make a pull request's priority score."
              id="scoring"
              onOpenChange={(nextOpen) => setSectionOpen("scoring", nextOpen)}
              open={scoringOpen}
              title="Scoring model"
            >
              <ScoringCard />
            </SettingsExpandableRow>
          </ItemGroup>
        </section>
      </div>
    </main>
  );
}
