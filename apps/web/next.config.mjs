import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Next doesn't pick up stray lockfiles elsewhere.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // TODO: add `transpilePackages: ["@shipfix/contracts"]` when the UI starts
  // importing shared workspace types/schemas.
};

export default nextConfig;
