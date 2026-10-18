import { defineConfig } from "vite";
import type { Plugin } from "vite";
import preact from "@preact/preset-vite";

function rootEntry(): Plugin {
  return {
    name: "root-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url === "/index.html") {
          req.url = "/web/index.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), rootEntry()],
  build: {
    outDir: "dist-web",
    rollupOptions: {
      input: "web/index.html",
    },
  },
});