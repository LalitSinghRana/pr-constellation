import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Label } from "@/components/ui/label.jsx";
import { parseList } from "@/lib/queue.js";

export function TeamSettingsForm({ busy, onSave, settings }) {
  const [draft, setDraft] = useState({ username: "", people: "", teams: "" });

  useEffect(() => {
    setDraft({
      username: settings.username,
      people: settings.people.join(", "),
      teams: settings.teams.join(", "),
    });
  }, [settings]);

  function update(field) {
    return (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  }

  const dirty =
    draft.username.trim() !== settings.username ||
    parseList(draft.people).join(",") !== settings.people.join(",") ||
    parseList(draft.teams).join(",") !== settings.teams.join(",");

  async function submit(event) {
    event.preventDefault();
    if (busy || !dirty) return;
    await onSave({
      username: draft.username.trim(),
      people: parseList(draft.people),
      teams: parseList(draft.teams),
    });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={submit}>
      <div className="grid gap-2">
        <Label htmlFor="username">GitHub username</Label>
        <Input
          autoComplete="off"
          disabled={busy}
          id="username"
          onChange={update("username")}
          pattern="[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
          placeholder="Auto-detected from gh"
          value={draft.username}
        />
        <p className="m-0 text-[0.72rem] leading-normal text-muted-foreground">
          Leave blank to use the account currently signed into{" "}
          <code className="rounded bg-muted px-[0.28rem] py-[0.08rem] text-foreground">gh</code>.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="people">Teammate usernames</Label>
        <Input
          autoComplete="off"
          disabled={busy}
          id="people"
          onChange={update("people")}
          placeholder="alice, bob, carol"
          value={draft.people}
        />
        <p className="m-0 text-[0.72rem] leading-normal text-muted-foreground">
          Comma-separated. Each teammate-authored PR receives +7.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="teams">GitHub teams</Label>
        <Input
          autoComplete="off"
          disabled={busy}
          id="teams"
          onChange={update("teams")}
          placeholder="your-org/platform, your-org/mobile"
          value={draft.teams}
        />
        <p className="m-0 text-[0.72rem] leading-normal text-muted-foreground">
          Use the full org/team name, separated by commas.
        </p>
      </div>

      <div className="flex items-end sm:col-span-2 lg:col-span-3">
        <Button disabled={busy || !dirty} type="submit">
          {busy ? "Saving…" : "Save team"}
        </Button>
      </div>
    </form>
  );
}
