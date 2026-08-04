"use client";

/**
 * Schedule-popover state for the toolbar Schedule button (extracted from
 * page.tsx, exit audit F1). Holds the anchorRect (for positioning) and the
 * vizId being scheduled. If the current viz hasn't been saved yet (no vizId),
 * auto-save first to obtain one.
 */
import { useCallback, useState } from "react";

export type ScheduleState =
  | { kind: "closed" }
  | { kind: "auto-saving" }
  | { kind: "open"; vizId: string; anchorRect: DOMRect };

interface UseSchedulePopoverArgs {
  loadedVizId: string | null;
  lastSavedVizId: string | null;
  doSave: () => Promise<string | null>;
}

export function useSchedulePopover({
  loadedVizId,
  lastSavedVizId,
  doSave,
}: UseSchedulePopoverArgs) {
  const [scheduleState, setScheduleState] = useState<ScheduleState>({ kind: "closed" });

  const handleScheduleClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      const anchorRect = e.currentTarget.getBoundingClientRect();
      if (loadedVizId) {
        setScheduleState({ kind: "open", vizId: loadedVizId, anchorRect });
        return;
      }
      if (lastSavedVizId) {
        setScheduleState({ kind: "open", vizId: lastSavedVizId, anchorRect });
        return;
      }
      setScheduleState({ kind: "auto-saving" });
      const newVizId = await doSave();
      if (!newVizId) {
        setScheduleState({ kind: "closed" });
        return;
      }
      setScheduleState({ kind: "open", vizId: newVizId, anchorRect });
    },
    [loadedVizId, lastSavedVizId, doSave]
  );

  return { scheduleState, setScheduleState, handleScheduleClick };
}
