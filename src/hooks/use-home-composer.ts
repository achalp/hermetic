"use client";

/**
 * Ask-first composer wiring for the home screen (extracted from page.tsx,
 * exit audit F1). The question is typed BEFORE data exists; attaching a
 * source is async, so the question is armed and fires once the source is
 * ready (isState2). Every attach action arms the currently-typed question
 * (if any) so picking a source with a question already written runs it with
 * zero extra clicks.
 */
import { useCallback, useMemo, useState, type RefObject } from "react";
import type { QueryMode } from "@/components/app/query-input";
import type { RecentItem } from "@/components/app/recent-sources";
import type { SavedConnectionItem } from "@/components/app/home/add-data-menu";
import type { ExampleRun } from "@/components/app/home/example-cards";
import { usePendingAsk } from "@/hooks/use-pending-ask";
import { ENGINES } from "@/lib/warehouse/engine-descriptor";
import type { useWarehouse } from "@/hooks/use-warehouse";
import type { SandboxRuntimeId } from "@/lib/constants";

interface UseHomeComposerArgs {
  isState2: boolean;
  queryMode: QueryMode;
  setQueryMode: (m: QueryMode) => void;
  handleGuardedQuery: (question: string, mode?: QueryMode) => Promise<void>;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  sandboxRuntime: SandboxRuntimeId;
  setShowLocalBrowser: (v: boolean) => void;
  setShowWarehouseForm: (v: boolean) => void;
  warehouse: ReturnType<typeof useWarehouse>;
  handleSampleData: () => Promise<void>;
  reopenRecent: (item: RecentItem) => Promise<void>;
}

export function useHomeComposer({
  isState2,
  queryMode,
  setQueryMode,
  handleGuardedQuery,
  uploadInputRef,
  sandboxRuntime,
  setShowLocalBrowser,
  setShowWarehouseForm,
  warehouse,
  handleSampleData,
  reopenRecent,
}: UseHomeComposerArgs) {
  const [homeQuestion, setHomeQuestion] = useState("");
  const runPendingAsk = useCallback(
    (question: string, mode: QueryMode) => {
      setQueryMode(mode);
      void handleGuardedQuery(question, mode);
    },
    [handleGuardedQuery, setQueryMode]
  );
  const { arm: armPendingAsk } = usePendingAsk(isState2, runPendingAsk);

  const armFromComposer = useCallback(() => {
    const q = homeQuestion.trim();
    if (q) armPendingAsk({ question: q, mode: queryMode });
  }, [homeQuestion, queryMode, armPendingAsk]);

  const composerUpload = useCallback(() => {
    armFromComposer();
    if (uploadInputRef.current) uploadInputRef.current.value = "";
    uploadInputRef.current?.click();
  }, [armFromComposer, uploadInputRef]);

  const composerLocalBrowse = useCallback(() => {
    if (sandboxRuntime !== "docker") {
      const label =
        sandboxRuntime === "e2b"
          ? "E2B (Cloud)"
          : sandboxRuntime === "microsandbox"
            ? "Microsandbox"
            : sandboxRuntime;
      alert(
        `Local file browsing requires the Docker runtime.\n\nCurrent runtime: ${label}.\nSwitch to Docker in Settings or re-run ./start.sh.`
      );
      return;
    }
    armFromComposer();
    setShowLocalBrowser(true);
  }, [armFromComposer, sandboxRuntime, setShowLocalBrowser]);

  const composerNewWarehouse = useCallback(() => {
    armFromComposer();
    setShowWarehouseForm(true);
  }, [armFromComposer, setShowWarehouseForm]);

  const composerSavedConnect = useCallback(
    (id: string) => {
      const saved = warehouse.savedConnections.find((c) => c.id === id);
      if (!saved) return;
      armFromComposer();
      void warehouse.connect(saved.config);
    },
    [armFromComposer, warehouse]
  );

  const composerSample = useCallback(() => {
    armFromComposer();
    void handleSampleData();
  }, [armFromComposer, handleSampleData]);

  const composerOpenRecent = useCallback(
    (item: RecentItem) => {
      armFromComposer();
      void reopenRecent(item);
    },
    [armFromComposer, reopenRecent]
  );

  // Example cards: question + sample dataset + mode in one click.
  const runExample = useCallback(
    (run: ExampleRun) => {
      setQueryMode(run.mode);
      setHomeQuestion(run.question);
      armPendingAsk({ question: run.question, mode: run.mode });
      void handleSampleData();
    },
    [armPendingAsk, handleSampleData, setQueryMode]
  );

  const savedConnectionItems = useMemo<SavedConnectionItem[]>(
    () =>
      warehouse.savedConnections.map((c) => ({
        id: c.id,
        name: c.name ?? c.label,
        brandColor: ENGINES[c.config.type]?.brandColor,
      })),
    [warehouse.savedConnections]
  );

  return {
    homeQuestion,
    setHomeQuestion,
    armFromComposer,
    composerUpload,
    composerLocalBrowse,
    composerNewWarehouse,
    composerSavedConnect,
    composerSample,
    composerOpenRecent,
    runExample,
    savedConnectionItems,
  };
}
