import { defineConfig } from "vite";

const rawPort = process.env.PORT;
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const basePath = process.env.BASE_PATH;
if (!basePath) throw new Error("BASE_PATH environment variable is required but was not provided.");

export default defineConfig({
  base: basePath,
  server: {
    port: Number(rawPort),
    proxy: { "/api": "http://localhost:8080" },
  },
});
