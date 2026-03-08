"use client";

import { useCallback, useState } from "react";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getArtifacts } from "@/lib/api";

interface UseArtifactsOptions {
  csvId: string | null;
}

export function useArtifacts({ csvId }: UseArtifactsOptions) {
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [artifacts, setArtifacts] = useState<CachedArtifacts | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);

  const handleToggleArtifacts = useCallback(async () => {
    if (showArtifacts) {
      setShowArtifacts(false);
      return;
    }
    if (!csvId) return;
    if (artifacts) {
      setShowArtifacts(true);
      return;
    }
    setArtifactsLoading(true);
    setArtifactsError(null);
    try {
      const data = await getArtifacts(csvId);
      setArtifacts(data);
      setShowArtifacts(true);
    } catch {
      setArtifactsError("Artifacts expired. Re-run the query or save the visualization first.");
      setTimeout(() => setArtifactsError(null), 4000);
    } finally {
      setArtifactsLoading(false);
    }
  }, [showArtifacts, csvId, artifacts]);

  return {
    showArtifacts,
    setShowArtifacts,
    artifacts,
    setArtifacts,
    artifactsLoading,
    artifactsError,
    handleToggleArtifacts,
  };
}
