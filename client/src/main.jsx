import { NuqsAdapter } from "nuqs/adapters/react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyTheme, readStoredTheme } from "./lib/theme.js";
import "./index.css";

applyTheme(readStoredTheme());

createRoot(document.querySelector("#root")).render(
  <NuqsAdapter>
    <App />
  </NuqsAdapter>,
);
