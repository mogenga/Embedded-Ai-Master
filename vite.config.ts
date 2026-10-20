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

const apiTarget = `http://127.0.0.1:${process.env.HARNESS_UI_PORT ?? "5174"}`;

export default defineConfig({
  plugins: [preact(), rootEntry()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", apiTarget);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist-web",
    rollupOptions: {
      input: "web/index.html",
    },
  },
});