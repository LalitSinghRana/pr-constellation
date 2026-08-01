import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.jsx";

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  function toggleTheme() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setDark(next);
  }

  return (
    <Button
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      className="text-muted-foreground"
      onClick={toggleTheme}
      size="icon-sm"
      title={`Switch to ${dark ? "light" : "dark"} theme`}
      variant="ghost"
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
