import { useEffect, useState } from "react";

function readColorMode() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useColorMode() {
  const [colorMode, setColorMode] = useState(readColorMode);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      setColorMode(readColorMode());
    };
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, []);

  return colorMode;
}
