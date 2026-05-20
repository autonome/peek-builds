import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = parseInt(process.env.DEV_PORT, 10) || 1420;

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildNumber = readFileSync(resolve(__dirname, "BUILD_NUMBER"), "utf-8").trim();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __BUILD_NUMBER__: JSON.stringify(`v${buildNumber}`),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
