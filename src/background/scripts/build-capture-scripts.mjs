#!/usr/bin/env node
// Builds the player-capture content scripts. Each one is injected on its own
// (registered with scripting.registerContentScripts), so each must be a
// self-contained classic script rather than part of the module build.
import { build } from "vite";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "../../", process.env.DIST_DIR ?? "dist");
const watch = process.argv.includes("--watch");

// In watch mode this process never exits, so it also watches the main
// background build (vite.config.ts) instead of chaining a second command.
if (watch) {
  await build({
    configFile: resolve(root, "vite.config.ts"),
    root,
    build: { watch: {} },
  });
}

const entries = [
  { name: "capture-hook", entry: "src/capture/capture-hook.ts" },
  { name: "capture-relay", entry: "src/capture/capture-relay.ts" },
];

for (const { name, entry } of entries) {
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    build: {
      lib: {
        entry: resolve(root, entry),
        name: name.replace(/-(\w)/g, (_, c) => c.toUpperCase()),
        formats: ["iife"],
        fileName: () => `${name}.js`,
      },
      target: "es2022",
      sourcemap: false,
      minify: false,
      outDir,
      emptyOutDir: false,
      watch: watch ? {} : null,
    },
  });
}
