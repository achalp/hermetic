import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@e2b/code-interpreter",
    "snowflake-sdk",
    "@databricks/sql",
    // Native addon (OS keychain) — must load from node_modules, not the bundle.
    "@napi-rs/keyring",
  ],
  transpilePackages: [
    "@deck.gl/core",
    "@deck.gl/react",
    "@deck.gl/layers",
    "@deck.gl/aggregation-layers",
    "@deck.gl/geo-layers",
  ],
};

export default withBundleAnalyzer(nextConfig);
