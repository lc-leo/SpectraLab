import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
  resolve: { tsconfigPaths: true },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "dist-offline",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: "src/offline-main.tsx",
      name: "SpectraLab",
      formats: ["iife"],
      fileName: () => "spectra-lab.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "spectra-lab.[ext]",
      },
    },
  },
});
