import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { useTheme } from "@/hooks/use-theme.js";

export function ThemeToggle() {
  const { dark, setTheme } = useTheme();

  return (
    <Button
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      className="text-muted-foreground"
      onClick={() => setTheme(dark ? "light" : "dark")}
      size="icon-sm"
      title={`Switch to ${dark ? "light" : "dark"} theme`}
      variant="ghost"
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
