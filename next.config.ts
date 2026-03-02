import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  serverExternalPackages: ["@e2b/code-interpreter"],
  transpilePackages: [
    "@deck.gl/core",
    "@deck.gl/react",
    "@deck.gl/layers",
    "@deck.gl/aggregation-layers",
    "@deck.gl/geo-layers",
  ],
};

export default withBundleAnalyzer(nextConfig);
