import { Plus } from "lucide-react";
import { useState } from "react";
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
import { Label } from "@/components/ui/label.jsx";

export function AddPullRequestDialog({ error, onAdd, pending }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");

  async function submit(event) {
    event.preventDefault();
    try {
      await onAdd(url);
      setUrl("");
      setOpen(false);
    } catch {
      // The parent surfaces the mutation error next to the form.
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setUrl("");
      }}
      open={open}
    >
      <Button onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
        <Plus className="size-3.5" />
        Add pull request
      </Button>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add a pull request</DialogTitle>
            <DialogDescription>
              Paste a GitHub pull request URL to keep it in this inbox even when GitHub did not
              notify you.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="inbox-add-pr-url">Pull request URL</Label>
            <Input
              autoComplete="off"
              id="inbox-add-pr-url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              required
              value={url}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={pending || !url.trim()} type="submit">
              {pending ? "Adding…" : "Add to inbox"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
