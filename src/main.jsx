import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

const savedTheme = localStorage.getItem("theme");
const dark = savedTheme
  ? savedTheme === "dark"
  : window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", dark);

createRoot(document.querySelector("#root")).render(<App />);
