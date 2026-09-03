import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [cloudflare(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The template engine is shared with the editor's live preview.
      // `worker/src/lib/interpolate.ts` imports nothing and touches no
      // Cloudflare globals, so it bundles for the browser as-is — the
      // alternative is a second copy of the grammar to keep in sync.
      "@worker": path.resolve(__dirname, "./worker/src"),
    },
    // Force a single React instance — prevents the "Invalid hook call" error
    // when lazy-loading @paper-design/shaders-react which can otherwise be
    // bundled with its own React copy.
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["@paper-design/shaders-react"],
  },
  build: {},
});
