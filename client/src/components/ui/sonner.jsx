import { CircleCheckIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/hooks/use-theme.js";

export function Toaster({ ...props }) {
  const { mode = "system" } = useTheme();

  return (
    <Sonner
      className="toaster group"
      closeButton
      icons={{
        close: <XIcon className="size-3" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
        success: <CircleCheckIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
      }}
      duration={3000}
      richColors
      theme={mode}
      toastOptions={{
        classNames: {
          toast: "group-[.toaster]:shadow-xs",
        },
      }}
      {...props}
    />
  );
}
