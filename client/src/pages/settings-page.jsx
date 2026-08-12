import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
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
import { EMPTY_SETTINGS } from "@/lib/queue.js";
import {
  DEFAULT_ANALYSIS_MODEL,
  SETTINGS_ANALYSIS_AGENTS,
} from "../../../shared/analysis-models.js";

export function SettingsPage() {
  useDocumentTitle({ title: "Settings · PR Review Cockpit" });
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingField, setSavingField] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setSettings(result);
        setSettingsLoaded(true);
      })
      .catch((caught) => {
        setError(caught.message || "Settings could not be loaded.");
        setSettingsLoaded(true);
      });
  }, []);

  async function patchSetting(field, value) {
    if (!settingsLoaded || savingField) return;
    setSavingField(field);
    setError("");
    const previous = settings;
    setSettings((current) => ({ ...current, [field]: value }));
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, [field]: value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setSettings(result);
    } catch (caught) {
      setSettings(previous);
      setError(caught.message || "Setting could not be saved.");
    } finally {
      setSavingField("");
    }
  }

  const busy = !settingsLoaded || Boolean(savingField);
  const defaultAnalysisModel = settings.defaultAnalysisModel || DEFAULT_ANALYSIS_MODEL;

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-[min(100%-2.5rem,42rem)] pt-12 pb-20 max-[700px]:w-[min(100%-1.5rem,42rem)] max-[700px]:pt-6">
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
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Turn cockpit features on or off. Preferences are saved in the local SQLite settings
            store.
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
                  Used when queueing analysis without picking a model.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Select
                  value={defaultAnalysisModel}
                  disabled={busy}
                  onValueChange={(value) => patchSetting("defaultAnalysisModel", value)}
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
                  onCheckedChange={(enabled) => patchSetting("autoQueue", enabled)}
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
                  onCheckedChange={(enabled) => patchSetting("showMinimap", enabled)}
                />
              </ItemActions>
            </Item>
          </ItemGroup>
        </section>
      </div>
    </main>
  );
}
