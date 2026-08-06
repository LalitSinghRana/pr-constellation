import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { parseList } from "@/lib/queue.js";

export function SettingsDialog({ open, onOpenChange, settings, onSave }) {
  const [draft, setDraft] = useState({ username: "", people: "", teams: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft({
        username: settings.username,
        people: settings.people.join(", "),
        teams: settings.teams.join(", "),
      });
    }
  }, [open, settings]);

  function update(field) {
    return (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    const saved = await onSave({
      username: draft.username.trim(),
      people: parseList(draft.people),
      teams: parseList(draft.teams),
    });
    setSaving(false);
    if (saved) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-primary">Queue inputs</p>
            <DialogTitle>Configure your review orbit</DialogTitle>
            <DialogDescription>
              These lists are saved locally on disk and used to score teammate and GitHub team
              activity.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="username">GitHub username</label>
            <Input
              id="username"
              value={draft.username}
              onChange={update("username")}
              placeholder="Auto-detected from gh"
              autoComplete="off"
              pattern="[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
            />
            <p className="m-0 text-[0.72rem] leading-normal text-muted-foreground">
              Leave blank to use the account currently signed into <code className="rounded bg-muted px-[0.28rem] py-[0.08rem] text-foreground">gh</code>.
            </p>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="people">Teammate usernames</label>
            <Input
              id="people"
              value={draft.people}
              onChange={update("people")}
              placeholder="alice, bob, carol"
              autoComplete="off"
            />
            <p className="m-0 text-[0.72rem] leading-normal text-muted-foreground">Comma-separated. Each teammate-authored PR receives +7.</p>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="teams">GitHub teams</label>
            <Input
              id="teams"
              value={draft.teams}
              onChange={update("teams")}
              placeholder="your-org/platform, your-org/mobile"
              autoComplete="off"
            />
            <p className="m-0 text-[0.72rem] leading-normal text-muted-foreground">Use the full org/team name, separated by commas.</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save and refresh"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
