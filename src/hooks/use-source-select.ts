"use client";

/**
 * Data-source selection, extracted from page.tsx (ARCH-5): the local-file
 * browser flow (file/folder → schema extraction), remote Parquet URLs, the
 * shared upload path (hidden <input> + drag-drop, Excel routed to the sheet
 * picker), and the sample-data shortcut. Owns the browser-visibility and
 * extraction-in-progress state those flows share.
 */
import { useCallback, useState, useRef } from "react";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";
import {
  extractLocalSchema,
  extractRemoteParquetSchema,
  fetchStaticAsset,
  uploadFile,
  type RemoteParquetCreds,
} from "@/app/lib/api";
import {
  connectManifest,
  ensureManifestEntity,
  getManifestEntityDetail,
  selectManifestEntities,
  type ManifestView,
  type ManifestEntityDetail,
} from "@/app/lib/manifest-connect";
import { isManifestUrl, type ConnectProgress } from "@/lib/manifest/shared";

/** One connect-progress event → a human phase line for the connect indicator. */
function describeConnectPhase(evt: ConnectProgress): { phase: string; detail: string } {
  switch (evt.phase) {
    case "fetching":
      return { phase: "fetching", detail: "Reading the catalog…" };
    case "adapting":
      return { phase: "adapting", detail: `Found ${evt.entities} tables — preparing…` };
    case "network-up":
      return { phase: "network-up", detail: "Opened a restricted network to the data host…" };
    case "extracting":
      return {
        phase: "extracting",
        detail: `Reading schema ${evt.index}/${evt.total}: ${evt.entity}…`,
      };
    case "extracted":
      return {
        phase: "extracted",
        detail: evt.cached
          ? `${evt.entity} (cached)`
          : evt.ok
            ? `${evt.entity} ✓`
            : `${evt.entity} — will read on first use`,
      };
    case "connected":
      return { phase: "connected", detail: `Connected — ${evt.entities} tables ready to query` };
  }
}

/**
 * What the CATALOG declares about an entity nobody has profiled yet — column
 * names and descriptions from the manifest document itself, which cost nothing
 * to show. Distinct from a CSVSchema: no dtypes, no samples, no statistics,
 * because nothing has read the data.
 */
export interface ManifestEntityPreview {
  name: string;
  columns: { name: string; description: string }[];
  description?: string;
}

export function useSourceSelect(args: {
  handleUpload: (csvId: string, schema: CSVSchema) => void;
  handleExcelSheets: (
    excelId: string,
    filename: string,
    sheets: SheetInfo[],
    relationships: SheetRelationship[]
  ) => void;
}) {
  const { handleUpload, handleExcelSheets } = args;

  const [showLocalBrowser, setShowLocalBrowser] = useState(false);
  const [isExtractingLocalSchema, setIsExtractingLocalSchema] = useState(false);
  // True once a remote Parquet source is loaded — gates the sidebar refresh
  // control (an uploaded CSV has no source to re-read).
  const [hasRemoteSource, setHasRemoteSource] = useState(false);
  // User-facing error from a source load (schema extraction, upload). Surfaced as
  // a dismissable banner by the page — previously these threw uncaught (the remote
  // path) or were console-logged only (local/upload), so a failure either hit the
  // Next.js error overlay or vanished silently.
  const [sourceError, setSourceError] = useState<string | null>(null);
  // Live connect progress — the Docker manifest connect spins an egress network
  // + a schema-extraction container per entity (~2 min); this narrates each
  // phase so the user sees the server working instead of a silent spinner (the
  // freeze that produced duplicate double-submitted connects).
  const [connectProgress, setConnectProgress] = useState<{
    phase: string;
    detail: string;
  } | null>(null);
  const errText = (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback;

  const handleLocalFileSelect = useCallback(
    async (path: string, type: "file" | "folder") => {
      setIsExtractingLocalSchema(true);
      try {
        const data = await extractLocalSchema(path, type);
        if (data.csv_id && data.schema) {
          handleUpload(data.csv_id, data.schema);
          setShowLocalBrowser(false);
        } else if (data.excel_id && data.sheets) {
          handleExcelSheets(
            data.excel_id,
            data.filename ?? "local.xlsx",
            data.sheets!,
            data.relationships ?? []
          );
          setShowLocalBrowser(false);
        }
      } catch (err) {
        console.warn("Local file schema extraction failed:", err);
        setSourceError(errText(err, "Couldn't read that file."));
      } finally {
        setIsExtractingLocalSchema(false);
      }
    },
    [handleUpload, handleExcelSheets]
  );

  // Last remote Parquet source loaded — lets the schema sidebar's "refresh"
  // re-read it (with force) without re-typing the URL.
  const lastRemoteRef = useRef<{ url: string; creds?: RemoteParquetCreds } | null>(null);

  // A connected dataset manifest (spec §6, revised in review): entities render
  // INSIDE the Data Explorer rail — list on top, the active entity's schema and
  // sample below — not in a separate panel. Selecting an entity makes it the
  // page's ACTIVE SOURCE, which is what feeds those sections.
  const [manifest, setManifest] = useState<ManifestView | null>(null);
  const [activeEntityName, setActiveEntityName] = useState<string | null>(null);
  /** Entity currently being profiled — drives the "loading" row + header hint. */
  const [loadingEntityName, setLoadingEntityName] = useState<string | null>(null);
  /**
   * The selected entity when it has NOT been profiled: what the catalog itself
   * declares. Null whenever the active entity's real schema is loaded.
   */
  const [entityPreview, setEntityPreview] = useState<ManifestEntityPreview | null>(null);

  /** Reflect a finished extraction in the entity list without a refetch. */
  const applyEntityDetail = useCallback((name: string, detail: ManifestEntityDetail) => {
    if (detail.status !== "ready" || !detail.csvId || !detail.schema) return;
    setManifest((prev) =>
      prev
        ? {
            ...prev,
            entities: prev.entities.map((e) =>
              e.name === name
                ? {
                    ...e,
                    status: "ready" as const,
                    csvId: detail.csvId!,
                    rowCount: detail.schema!.row_count,
                    rowCountIsExact: true,
                    columnCount: detail.schema!.columns.length,
                  }
                : e
            ),
          }
        : prev
    );
  }, []);

  const handleRemoteFileSelect = useCallback(
    async (url: string, creds?: RemoteParquetCreds, force?: boolean) => {
      lastRemoteRef.current = { url, creds };
      setHasRemoteSource(true);
      setIsExtractingLocalSchema(true);
      setSourceError(null);
      try {
        // Manifest detection (spec §5.1): a .json URL is a CATALOG of entities,
        // not a parquet source. Connect it, then auto-select the first entity so
        // the Data Explorer opens showing the list + a real schema immediately —
        // preferring one that is already ready (no extraction wait), else lazily
        // extracting the first.
        if (isManifestUrl(url)) {
          const view = await connectManifest(url, creds, force, (evt) =>
            setConnectProgress(describeConnectPhase(evt))
          );
          setConnectProgress(null);
          setManifest(view);
          // TWO-TIER (profile-on-demand): connect LISTS the catalog and never
          // profiles. Value profiling (the 500k-row sample) costs ~50s of egress
          // PER ENTITY — measured on Overture division_area — so doing it for a
          // whole catalog at connect burned minutes on entities the user may
          // never ask about, and still could not finish. It now happens only
          // when an analysis needs an entity, or when the user explicitly asks
          // for it ("Profile" in the rail). Entities profiled in a PREVIOUS
          // session still arrive ready: connect keeps the free cache pass.
          //
          // No background warm-up loop: speculative profiling against a metered
          // source (object-store egress, a large warehouse) is exactly the cost
          // a user cannot see or cancel.
          const alreadyProfiled = view.entities.find((e) => e.status === "ready");
          if (alreadyProfiled?.csvId) {
            const detail = await getManifestEntityDetail(view.manifestId, alreadyProfiled.name);
            if (detail.csvId && detail.schema) {
              setActiveEntityName(alreadyProfiled.name);
              handleUpload(detail.csvId, detail.schema);
            }
          }
          setShowLocalBrowser(false);
          return;
        }
        const data = await extractRemoteParquetSchema(url, creds, force);
        handleUpload(data.csv_id, data.schema);
        setShowLocalBrowser(false);
      } catch (err) {
        // Catch (don't rethrow) so the failure shows as an in-app banner instead
        // of the Next.js error overlay. err.message is already user-friendly
        // (see friendlyParquetError in the schema route). NOTE: use console.warn,
        // NOT console.error — Next 16's dev overlay surfaces console.error(Error)
        // as a "Console ApiError", which would re-cover the app on top of the banner.
        console.warn("Remote Parquet schema extraction failed:", err);
        setSourceError(errText(err, "Couldn't read that Parquet source."));
      } finally {
        setIsExtractingLocalSchema(false);
        setConnectProgress(null); // clear the phase line on success or failure
      }
    },
    [handleUpload]
  );

  /** Re-read the last remote Parquet source, bypassing the schema cache. */
  const refreshRemote = useCallback(async () => {
    const last = lastRemoteRef.current;
    if (last) await handleRemoteFileSelect(last.url, last.creds, true);
  }, [handleRemoteFileSelect]);

  // Shared upload path: used by both the hidden <input> and files dropped
  // directly onto the upload card. Routes Excel workbooks to the sheet picker.
  const processUploadFile = useCallback(
    async (file: File) => {
      try {
        const formData = new FormData();
        formData.append("csv", file);
        const data = await uploadFile(formData);
        if (data.excel_id && data.sheets) {
          handleExcelSheets(
            data.excel_id,
            data.filename ?? file.name,
            data.sheets,
            data.relationships ?? []
          );
        } else if (data.csv_id && data.schema) {
          handleUpload(data.csv_id, data.schema);
        }
      } catch (err) {
        console.warn("Upload failed:", err);
        setSourceError(errText(err, "Upload failed."));
      }
    },
    [handleExcelSheets, handleUpload]
  );

  const handleSampleData = useCallback(async () => {
    try {
      const blob = await fetchStaticAsset("/sample-data/sales-data.csv");
      const file = new File([blob], "sales-data.csv", { type: "text/csv" });
      const formData = new FormData();
      formData.append("csv", file);
      const data = await uploadFile(formData);
      if (data.csv_id && data.schema) {
        handleUpload(data.csv_id, data.schema);
      }
    } catch (err) {
      console.warn("Sample data load failed:", err);
      setSourceError(errText(err, "Couldn't load the sample dataset."));
    }
  }, [handleUpload]);

  /**
   * Select an entity in the Data Explorer list. Selection is CHEAP: it never
   * profiles. An entity already profiled (this session or a previous one, via
   * the schema cache) becomes the active source with its full schema; one that
   * isn't shows what the catalog itself declares — columns, descriptions, the
   * manifest's row-count hint — plus a "Profile" button.
   *
   * Browsing a catalog must not cost ~50s of remote egress per click, and on a
   * 1000-table warehouse it must not cost anything at all. Value profiling runs
   * when a QUESTION needs the entity, or when the user asks for it here.
   */
  const selectManifestEntity = useCallback(
    async (name: string) => {
      if (!manifest || name === activeEntityName) return;
      setSourceError(null);
      try {
        const detail = await getManifestEntityDetail(manifest.manifestId, name);
        setActiveEntityName(name);
        if (detail.csvId && detail.schema) {
          setEntityPreview(null);
          handleUpload(detail.csvId, detail.schema);
        } else {
          // Declared-only view. The previous entity's schema must NOT keep
          // showing under this entity's name, so the preview takes over the
          // rail's schema/profile/sample sections.
          setEntityPreview({
            name,
            columns: detail.columnDocs ?? [],
            ...(detail.description ? { description: detail.description } : {}),
          });
        }
      } catch (err) {
        console.warn("Manifest entity selection failed:", err);
        setSourceError(errText(err, `Couldn't read entity "${name}".`));
      }
    },
    [manifest, activeEntityName, handleUpload]
  );

  /**
   * "Profile this table" — the EXPLICIT user action. Runs the same full
   * extraction a question would (500k-row value profile, cached by fingerprint),
   * then makes the entity the active source so its real schema, profile chips
   * and sample rows render.
   */
  const profileManifestEntity = useCallback(
    async (name: string) => {
      if (!manifest) return;
      setIsExtractingLocalSchema(true);
      setLoadingEntityName(name);
      setSourceError(null);
      try {
        const detail = await ensureManifestEntity(manifest, name, lastRemoteRef.current?.creds);
        if (!detail.csvId || !detail.schema) {
          setSourceError(detail.error ?? `Couldn't profile "${name}".`);
          return;
        }
        // Reflect the extraction in the list without a refetch round trip.
        applyEntityDetail(name, detail);
        setEntityPreview(null);
        setActiveEntityName(name);
        handleUpload(detail.csvId, detail.schema);
      } catch (err) {
        console.warn("Manifest entity profiling failed:", err);
        setSourceError(errText(err, `Couldn't profile "${name}".`));
      } finally {
        setIsExtractingLocalSchema(false);
        setLoadingEntityName(null);
      }
    },
    [manifest, handleUpload, applyEntityDetail]
  );

  /**
   * Prepared multi-entity context for the NEXT question (spec §7): set by
   * prepareManifestForQuestion right before the ask/investigate dispatch,
   * consumed by the stream request. Cleared when there is no manifest.
   */
  const [manifestQuestion, setManifestQuestion] = useState<{
    manifest_id: string;
    entities: { name: string; csv_id: string }[];
  } | null>(null);

  /**
   * How the CURRENT question's table scope was decided — surfaced in the
   * interstitial so the per-question pick (and especially the silent
   * single-entity fallback) is visible instead of implied by the preview
   * selection. "selecting" while the pre-step runs; cleared with the manifest.
   */
  const [manifestPick, setManifestPick] = useState<
    | { kind: "selecting" }
    | { kind: "picked"; names: string[]; dropped?: string[] }
    | { kind: "fallback"; active: string | null }
    | null
  >(null);

  /**
   * The selection pre-step + ensure, run BEFORE a question dispatches (both
   * modes — handleGuardedQuery is the shared gate). Never blocks the question:
   * any failure falls back to the single active entity.
   */
  const prepareManifestForQuestion = useCallback(
    async (question: string) => {
      if (!manifest) {
        setManifestQuestion(null);
        setManifestPick(null);
        return;
      }
      setManifestPick({ kind: "selecting" });
      try {
        const { entities: picked, autoIncluded = [] } = await selectManifestEntities(
          manifest.manifestId,
          question
        );
        if (!picked?.length) throw new Error("selection unavailable");

        // Ensure every picked entity is ready (the existing lazy flow, with the
        // same loading UI a browser click drives). Kept sequential: each may be
        // a wasm two-hop worker extraction, and one worker at a time is plenty.
        // ONE retry per entity: a transient network blip during extraction cost
        // run a897dbcc its subject entity (the buildings of a buildings question).
        const ready: { name: string; csvId: string; detail: ManifestEntityDetail }[] = [];
        const dropped: string[] = [];
        for (const name of picked) {
          setLoadingEntityName(name);
          try {
            let detail: ManifestEntityDetail;
            try {
              detail = await ensureManifestEntity(manifest, name, lastRemoteRef.current?.creds);
            } catch {
              detail = await ensureManifestEntity(manifest, name, lastRemoteRef.current?.creds);
            }
            if (detail.csvId && detail.schema) ready.push({ name, csvId: detail.csvId, detail });
            else dropped.push(name);
          } catch (err) {
            console.warn(`Manifest pre-step: entity "${name}" failed to load:`, err);
            dropped.push(name);
          } finally {
            setLoadingEntityName(null);
          }
        }
        // AUTO-INCLUDED escorts (boundary polygons) never satisfy a pick on
        // their own: if every entity the MODEL chose failed to load, running on
        // the escorts answers a different question than the one asked (run
        // a897dbcc: a buildings question answered from division tables). Treat
        // it as a failed pre-step → the single-active-entity fallback below.
        const modelPickedReady = ready.filter((r) => !autoIncluded.includes(r.name));
        if (ready.length === 0 || modelPickedReady.length === 0) {
          throw new Error(
            dropped.length
              ? `picked entities failed to load: ${dropped.join(", ")}`
              : "no picked entity became ready"
          );
        }

        // The PRIMARY (first picked) becomes the active source, so the request's
        // csv_id, the explorer highlight, and the pipeline's plumbing all agree.
        const primary = ready[0]!;
        setActiveEntityName(primary.name);
        handleUpload(primary.csvId, primary.detail.schema!);
        setManifestQuestion({
          manifest_id: manifest.manifestId,
          entities: ready.map((r) => ({ name: r.name, csv_id: r.csvId })),
        });
        setManifestPick({
          kind: "picked",
          names: ready.map((r) => r.name),
          ...(dropped.length ? { dropped } : {}),
        });
      } catch (err) {
        // Fall back to the single ACTIVE entity — a broken pre-step must never
        // block the question (a degradation, not an error). The interstitial
        // surfaces the narrowing (it used to be invisible).
        console.warn("Manifest selection pre-step failed; single-entity fallback:", err);
        // With profile-on-demand nothing is guaranteed profiled, so the fallback
        // has to MAKE a source rather than assume one: profile the active entity
        // (or the catalog's first) before giving up, else the question would
        // dispatch against no data at all.
        const fallbackName = activeEntityName ?? manifest.entities[0]?.name ?? null;
        if (fallbackName) {
          setLoadingEntityName(fallbackName);
          try {
            const detail = await ensureManifestEntity(
              manifest,
              fallbackName,
              lastRemoteRef.current?.creds
            );
            if (detail.csvId && detail.schema) {
              applyEntityDetail(fallbackName, detail);
              setEntityPreview(null);
              setActiveEntityName(fallbackName);
              handleUpload(detail.csvId, detail.schema);
            }
          } catch (fallbackErr) {
            console.warn("Manifest fallback entity failed to load:", fallbackErr);
          } finally {
            setLoadingEntityName(null);
          }
        }
        setManifestQuestion(null);
        setManifestPick({ kind: "fallback", active: fallbackName });
      }
    },
    [manifest, handleUpload, activeEntityName, applyEntityDetail]
  );

  /** Source-scoped UI state cleared by the page-level reset. */
  const resetSourceSelect = useCallback(() => {
    setShowLocalBrowser(false);
    setIsExtractingLocalSchema(false);
    setHasRemoteSource(false);
    setSourceError(null);
    setManifest(null);
    setActiveEntityName(null);
    setLoadingEntityName(null);
    setEntityPreview(null);
    setManifestQuestion(null);
    setManifestPick(null);
    setConnectProgress(null);
    lastRemoteRef.current = null;
  }, []);

  return {
    showLocalBrowser,
    setShowLocalBrowser,
    isExtractingLocalSchema,
    handleLocalFileSelect,
    handleRemoteFileSelect,
    refreshRemote,
    connectProgress,
    hasRemoteSource,
    processUploadFile,
    handleSampleData,
    resetSourceSelect,
    sourceError,
    clearSourceError: () => setSourceError(null),
    manifest,
    activeEntityName,
    loadingEntityName,
    entityPreview,
    selectManifestEntity,
    profileManifestEntity,
    manifestQuestion,
    manifestPick,
    prepareManifestForQuestion,
  };
}
