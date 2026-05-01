/**
 * RangerAI Standalone Vite Config — Manus-free
 * 
 * This config is used for building the frontend on the Aliyun server
 * without any Manus platform dependencies.
 * 
 * Usage: npx vite build --config vite.config.standalone.ts
 * 
 * Iter-63: Fixed cross-chunk dependency issue.
 * Problem: manualChunks for mermaid/shiki caused Rollup to place shared code
 * (Vite preload helper, interop helpers) inside those heavy chunks. This forced
 * the main bundle to static-import vendor-mermaid (475KB gz) and vendor-shiki (843KB gz)
 * on every page load, even though these are only needed for chat rendering.
 * 
 * Fix: Remove mermaid and shiki from manualChunks. Rollup naturally splits them
 * into separate chunks via code-splitting, and shared helpers stay in the entry chunk.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(import.meta.dirname, "client", "src") },
      { find: "@shared", replacement: path.resolve(import.meta.dirname, "shared") },
      { find: "@assets", replacement: path.resolve(import.meta.dirname, "attached_assets") },
      // Iter-61: Redirect shiki main entry to web bundle (56 langs, lazy-loaded)
      { find: /^shiki$/, replacement: "shiki/bundle/web" },
    ],
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    // Disable modulePreload HTML tags — modern browsers handle this natively
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            const getPackageName = (id: string) => {
              const parts = id.split('node_modules/');
              const last = parts[parts.length - 1];
              if (last.startsWith('@')) {
                return last.split('/').slice(0, 2).join('/');
              }
              return last.split('/')[0];
            };
            const pkg = getPackageName(id);

            // === Heavy vendor chunks ===
            // NOTE: mermaid and shiki are intentionally NOT listed here.
            // When they are in manualChunks, Rollup places shared code (Vite preload
            // helper, interop helpers) inside them. This forces the main bundle to
            // static-import these heavy chunks (475KB + 843KB gz) on every page load.
            // By letting Rollup handle them naturally, shared helpers stay in the entry
            // chunk and these heavy packages are only loaded when actually needed.
            if (pkg === 'cytoscape') return 'vendor-cytoscape';
            if (pkg === 'katex') return 'vendor-katex';
            if (pkg === 'recharts' || pkg === 'victory-vendor' || pkg === 'recharts-scale' || pkg === 'react-smooth') return 'vendor-recharts';

            // === Core vendor chunks (loaded on every page) ===
            if (pkg === 'lucide-react') return 'vendor-icons';
            if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'vendor-react';

            // === Shared vendor-common: small deps used across multiple chunks ===
            const commonPkgs = [
              'clsx', 'class-variance-authority', 'tailwind-merge',
              'lodash', 'lodash-es',
              'eventemitter3',
              'd3-color', 'd3-interpolate', 'd3-path', 'd3-shape', 'd3-scale', 'd3-array',
              'd3-format', 'd3-time', 'd3-time-format',
              'tiny-invariant',
              'marked',
              
              
            ];
            if (commonPkgs.some(p => pkg === p || pkg.startsWith(p + '/'))) {
              return 'vendor-common';
            }
          }
        },
      },
    },
  },
  server: {
    host: true,
    allowedHosts: [
      "ranger.voyage",
      "www.ranger.voyage",
      "localhost",
      "127.0.0.1",
    ],
  },
});
