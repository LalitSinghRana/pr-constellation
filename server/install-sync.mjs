console.warn("install:sync was replaced by install:service; installing the continuous service.");
await import("./install-service.mjs");
