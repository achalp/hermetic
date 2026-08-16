/**
 * Single-shot dashboard composition — extracted from the Ask route so it can be
 * shared with the Investigate "lookup" fast-path (a follow-up the classifier
 * judged shallow enough to answer with one pass instead of a full multi-step
 * investigation). Keeping it here makes the deterministic, highest-risk parts
 * (the conditional compose prompt; dataset/filterable detection; the
 * finalize-and-inject stream loop) unit-testable without a live LLM call.
 *
 * `buildDashboardComposeRequest` is pure: given an execution result + options it
 * returns the compose `userPrompt` + `customRules` and the dataset analysis the
 * stream step needs. It is a thin assembler over per-section builders
 * (`analyzeDatasets`, the `build*Section` functions, `buildComposeRules`) so
 * each concern — filterable-column detection, sample flagging, drill-down
 * framing, the rules catalog — can be read and changed in isolation.
 * `composeAndStreamDashboard` runs the LLM + streams the finalized spec.
 */

import { streamText } from "ai";
import type { DrillDownContext } from "@/lib/contracts/analysis-request";
export type { DrillDownContext };
import { getModel, cachedSystem } from "@/lib/llm/client";

import { catalog } from "@/lib/catalog";
import { LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";

import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";

import { parseProduct, declaredUnitMap, productRolesIndex } from "@/lib/product";
import { lintComponentSignature } from "@/lib/product/signatures";
import { getComposerMode } from "@/lib/runtime-config";
import { compileDashboard } from "@/lib/compose/compile";
import { realizeNodeTemplate } from "@/lib/compose/realizer";
import { recordFailure } from "@/lib/diagnostics/failure-log";
import { generatePlan as generateNarrativePlan } from "@/lib/compose/planner";
import { deriveViews, viewPromptTitle } from "@/lib/compose/views";
import type { PlanDocument } from "@/lib/contracts/plan";

import { planHeadlineTiles } from "@/lib/findings/headline-plan";
import {
  lintUnitPhrase,
  lintSentinelInterpolation,
  lintSignedLanguage,
  lintSignificanceMismatch,
  lintShareBasisMismatch,
  lintSuperlativeHidesRaw,
  lintDanglingFindingReference,
} from "@/lib/findings/lints";
import type { FindingIssue } from "@/lib/contracts/findings";
import { type ValidStateKeys } from "@/lib/llm/resolve-placeholders";
import { auditComputedKeys, type PatchLike } from "@/lib/pipeline/computed-key-audit";
import {
  collectNarrativeStrings,
  collectGroundedValues,
  collectStringLeaves,
  verifyGrounding,
} from "@/lib/pipeline/grounding";
import { logger, errMessage } from "@/lib/logger";
import type { SandboxExecutionResult } from "@/lib/contracts/execution";

import { buildDashboardComposeRequest } from "./dashboard-compose-prompt";
import type { DashboardComposeOpts } from "./dashboard-compose-prompt";
export {
  mirroredResultKeys,
  buildValuesSection,
  buildDashboardComposeRequest,
  INTERACTIVE_ROW_CAP,
  VALUES_SECTION_MAX_BYTES,
} from "./dashboard-compose-prompt";
export type {
  DashboardComposeOpts,
  DashboardAnalysis,
  DashboardComposeRequest,
} from "./dashboard-compose-prompt";

export async function composeAndStreamDashboard(args: {
  executionResult: SandboxExecutionResult;
  opts: DashboardComposeOpts;
  uiComposeModel: string;
  emit: (data: string) => void;
  isClosed: () => boolean;
  /** Called just before the LLM stream begins (e.g. to emit a progress event). */
  onComposing?: () => void;
  /** Compiled mode: receives the plan document for persistence/editing. */
  onPlanDocument?: (doc: PlanDocument) => void;
}): Promise<void> {
  const { executionResult, opts, uiComposeModel, emit, isClosed, onComposing } = args;
  const { userPrompt, customRules, analysis } = buildDashboardComposeRequest(executionResult, opts);
  const { useDataController, mainDataset, imagePlaceholders, sampleNote } = analysis;

  onComposing?.();

  // Composer architecture (narrative-compiler spec §3): "compiled" replaces
  // the generative dashboard stream with a typed PLAN call + deterministic
  // compilation — the lines still flow through the SAME finalizer below, so
  // resolution, units, discourse checks and every post-pass are one stack.
  // Requires a declared-series product + manifest; legacy envelopes fall
  // back to generative (logged).
  const modeProduct = parseProduct(executionResult.series, executionResult.values).product;
  const compiledMode =
    getComposerMode() === "compiled" &&
    modeProduct.series.length > 0 &&
    (opts.findings?.manifest.findings.length ?? 0) > 0;
  if (getComposerMode() === "compiled" && !compiledMode) {
    logger.info("Compiled composer requested but envelope is legacy — using generative", {
      series: modeProduct.series.length,
      findings: opts.findings?.manifest.findings.length ?? 0,
    });
  }
  let compiledPlanDoc: PlanDocument | null = null;
  const textStream: AsyncIterable<string> = compiledMode
    ? (async function* () {
        // Body runs lazily at first iteration — headlinePlan/product consts
        // below are initialized by then.
        const findingsList = opts.findings!.manifest.findings;
        const shippedViews = deriveViews({
          series: modeProduct.series,
          regimes: (executionResult.regimes ?? {}) as Record<string, unknown>,
          purpose: opts.purpose,
        }).filter((v) => v.shipped);
        const geojsonKey =
          (executionResult.chart_data ?? {}) instanceof Object &&
          "geojson" in ((executionResult.chart_data ?? {}) as Record<string, unknown>)
            ? "geojson"
            : undefined;
        const declaredPayloads = Array.isArray((executionResult as { payloads?: unknown }).payloads)
          ? (
              (executionResult as { payloads?: unknown }).payloads as {
                id: string;
                format: string;
              }[]
            ).filter((p) => typeof p?.id === "string" && typeof p?.format === "string")
          : [];
        const { plan } = await generateNarrativePlan({
          findings: findingsList,
          question: opts.question,
          model: uiComposeModel,
          purpose: opts.purpose,
          views: shippedViews.map((v) => ({ id: v.id, title: viewPromptTitle(v) })),
          series: modeProduct.series,
          payloads: declaredPayloads,
          hasGeojson: geojsonKey !== undefined,
        });
        compiledPlanDoc = {
          plan,
          overlay: opts.planOverlay ?? {},
          mode: "compiled",
          purpose: opts.purpose,
          // Persist the geometry channel so the edit-path recompile ships the
          // same map (finding 08/H3) — the recompile has no execution result
          // to re-derive it from.
          ...(geojsonKey ? { geojsonKey } : {}),
        };
        const lines = compileDashboard({
          manifest: opts.findings!.manifest,
          product: modeProduct,
          plan,
          geojsonKey,
          overlay: compiledPlanDoc.overlay,
          headlinePlan: planHeadlineTiles(
            findingsList,
            (executionResult.results ?? {}) as Record<string, unknown>,
            opts.question,
            modeProduct.values
          ),
          question: opts.question,
          purpose: opts.purpose,
          regimes: (executionResult.regimes ?? {}) as Record<string, unknown>,
          datasets: executionResult.datasets as Record<string, unknown> | undefined,
        });
        yield lines.join("\n") + "\n";
      })()
    : streamText({
        model: getModel(uiComposeModel),
        system: cachedSystem(catalog.prompt({ customRules })),
        prompt: userPrompt,
        temperature: 0,
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      }).textStream;

  let buffer = "";
  let stateInjected = false;
  let lineCount = 0;
  // Accumulate finalized patches so we can audit computed-key producers once the
  // spec is fully composed (warn-only — see auditComputedKeys).
  const composedPatches: PatchLike[] = [];
  // Narrative prose accumulated across the stream, for the grounding pass below.
  const narrativeTexts: string[] = [];
  const emitPatch = (line: string) => {
    emit(line + "\n");
    try {
      collectNarrativeStrings((JSON.parse(line) as { value?: unknown }).value, 0, narrativeTexts);
    } catch {
      // non-JSON keepalive / partial — nothing to collect
    }
  };

  // ALWAYS enabled (both modes): the repair used to be gated on
  // useDataController — but the failure it exists for happens precisely
  // when the composer emits DataController-style /computed bindings in a
  // run the pipeline decided was NON-DC (observed: every chart empty,
  // "$state": "/computed/monthly_line" with the data at
  // /datasets/monthly_churn_line and no DataController element at all).
  const validStateKeys: ValidStateKeys = {
    computed: new Set<string>([
      ...Object.keys(executionResult.chart_data ?? {}),
      ...Object.keys(executionResult.results ?? {}),
    ]),
    datasets: new Set<string>([...Object.keys(executionResult.chart_data ?? {}), "main"]),
  };

  // §4.2: finding values bind by (bare) name in single-shot compose.
  const findingValues = Object.fromEntries(
    (opts.findings?.manifest.findings ?? []).map((f) => [f.name, f.value])
  );
  // §3.4 citation tracking: which declared findings the composer actually
  // bound, scanned on the PRE-resolution line (post-resolution the token is
  // gone). Base name only — a .field binding cites the finding.
  const citedFindings = new Set<string>();
  const headlineBound = new Set<string>();
  // Prose-quality lints on the PRE-resolution line: unit re-phrasing around a
  // bound finding, and sentinel/boolean values interpolated into word slots
  // ("rates are Yes"). Value-aware — only the server can catch these; the
  // composer is values-blind by design. Deduped by kind+name; advisory only.
  const unitByName = new Map<string, string>(
    (opts.findings?.manifest.findings ?? [])
      .filter((f) => typeof f.unit === "string" && f.unit.length > 0)
      .map((f) => [f.name, f.unit as string])
  );
  const findingValueMap = new Map<string, unknown>(Object.entries(findingValues));
  const proseLintIssues = new Map<string, FindingIssue>();
  // Recomputed here (pure) for scaffold enforcement — the prompt-side plan
  // is built in buildDashboardComposeRequest with identical inputs.
  const { product: composedProduct } = parseProduct(executionResult.series, executionResult.values);
  // Declared roles by chart key — drives the component-signature check on
  // each composed line (a LineChart over a declared categorical x, etc.).
  const composeRolesIdx = productRolesIndex(composedProduct.series);
  const headlinePlan = planHeadlineTiles(
    opts.findings?.manifest.findings ?? [],
    (executionResult.results ?? {}) as Record<string, unknown>,
    opts.question,
    composedProduct.values
  );
  // Did the composed spec bind any {"$state": ...} path? When it did in a
  // NON-DataController run (composer drift), the datasets injection below
  // must still fire or the (possibly repaired) /datasets/<key> bindings
  // resolve to nothing and every chart renders empty.
  let sawStateBinding = false;

  const finalize = createSpecFinalizer({
    results: executionResult.results,
    chartData: executionResult.chart_data,
    findings: findingValues,
    findingUnits: Object.fromEntries(unitByName),
    // Resolution-time unit identity from declarations (analysis-product):
    // declare_value units + finding-mirror units beat key-name suffixes.
    declaredUnits: declaredUnitMap(composedProduct.values, opts.findings?.manifest.findings ?? []),
    imagePlaceholders,
    validStateKeys,
    mutatePatch: (patch) => {
      if (
        useDataController &&
        !stateInjected &&
        mainDataset &&
        patch.op === "add" &&
        patch.path === "/state" &&
        patch.value &&
        typeof patch.value === "object"
      ) {
        const value = patch.value as Record<string, unknown>;
        const datasets = (value.datasets ??= {}) as Record<string, unknown>;
        datasets.main = mainDataset;
        for (const [key, v] of Object.entries(executionResult.chart_data)) {
          if (v && typeof v === "object") datasets[key] = v;
        }
        stateInjected = true;
        return true;
      }
      // Deterministically stamp the sample caveat onto the DataController element,
      // regardless of what the LLM emitted, so the user is always warned when the
      // interactive data is a sample.
      if (
        sampleNote &&
        patch.op === "add" &&
        typeof patch.path === "string" &&
        patch.path.startsWith("/elements/") &&
        patch.value &&
        typeof patch.value === "object" &&
        (patch.value as { type?: unknown }).type === "DataController"
      ) {
        const el = patch.value as { props?: Record<string, unknown> };
        el.props = el.props ?? {};
        if (!el.props.sample_note) {
          el.props.sample_note = sampleNote;
          return true;
        }
      }
      return false;
    },
  });

  // Duplicate-tile suppression (two runs of 'Total X' twice): the SECOND
  // StatCard with an identical (label, value) is dropped deterministically.
  const seenTileSigs = new Set<string>();
  const processLine = (line: string): string | null => {
    const result = finalize(line);
    if (result.skip) return null;
    const val = result.patch?.value as
      | { type?: unknown; props?: { label?: unknown; value?: unknown } }
      | undefined;
    if (val && typeof val === "object" && val.type === "StatCard") {
      const sig = JSON.stringify([val.props?.label, val.props?.value]);
      if (seenTileSigs.has(sig)) {
        proseLintIssues.set(`duplicate_tile:${sig}`, {
          kind: "duplicate_tile",
          detail: `dropped a duplicate headline tile ${sig}`,
        });
        return null;
      }
      seenTileSigs.add(sig);
    }
    lineCount++;
    if (result.patch) composedPatches.push(result.patch as PatchLike);
    if (result.line.includes('"$state"')) sawStateBinding = true;
    for (const issue of result.discourseIssues ?? []) {
      proseLintIssues.set(`${issue.kind}:${issue.detail}`, issue);
    }
    const proseLintLookup = {
      findings: findingValueMap,
      results: (executionResult.results ?? {}) as Record<string, unknown>,
    };
    for (const issue of [
      ...lintUnitPhrase(result.raw, unitByName),
      ...lintSentinelInterpolation(result.raw, proseLintLookup),
      ...lintSignedLanguage(result.raw, proseLintLookup),
      ...lintSignificanceMismatch(result.raw, proseLintLookup),
      ...lintShareBasisMismatch(result.raw, opts.findings?.manifest.findings ?? []),
      ...lintComponentSignature(result.raw, composeRolesIdx),
    ]) {
      proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
    }
    for (const m of result.raw.matchAll(/\$finding:([a-zA-Z0-9_]+)/g)) {
      citedFindings.add(m[1]);
      // Headline coverage (§3.5): bindings inside StatCard elements.
      const isStatCard =
        result.patch?.value &&
        typeof result.patch.value === "object" &&
        (result.patch.value as { type?: unknown }).type === "StatCard";
      if (isStatCard) headlineBound.add(m[1]);
    }
    return result.line;
  };

  try {
    // NOTE: we do NOT stop on isClosed() — the compose runs to completion even if
    // the client disconnected, so the FULL patch stream is produced. emit() no-ops
    // to the dead socket, but the route accumulates the patches to assemble + save
    // the spec (a mid-run disconnect must not waste the analysis).
    for await (const chunk of textStream) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const result = processLine(line.trim());
        if (result !== null) emitPatch(result);
      }
    }
    if (buffer.trim()) {
      const result = processLine(buffer.trim());
      if (result !== null) emitPatch(result);
    }

    if (compiledPlanDoc) args.onPlanDocument?.(compiledPlanDoc);

    // ── Post-render invariants (specs/finding-field-roles-2026-08-13.md §2.M5) ──
    // Plan validation guarantees the credibility floor at AUTHORING time;
    // nothing used to re-check after resolution, and run f47eb42d shipped a
    // document whose ANSWER resolved to "" (its one sentence bound an
    // unrenderable value and was stripped). The verifier saw it and was
    // advisory. Here, after the full compiled document has been finalized:
    // any plan node whose element resolved EMPTY degrades to its
    // deterministic template (findings-bound, cannot be empty for
    // resolvable refs), re-finalized through the same processLine path so
    // resolution, lints and citation tracking all apply. An ANSWER that is
    // STILL empty is a structural failure — recorded, never shipped silent.
    // Snapshot through a widened alias: TS's flow analysis cannot see the
    // assignment inside the lazily-evaluated generator above, so reading
    // `compiledPlanDoc` here narrows to `null` (and `never` under a truthy
    // guard). The declared type is the truth.
    const planDoc: PlanDocument | null = compiledPlanDoc as PlanDocument | null;
    if (planDoc) {
      const manifestByName = new Map(
        (opts.findings?.manifest.findings ?? []).map((f) => [f.name, f])
      );
      const emptyPlanNodeIds = new Set<string>();
      for (const patch of composedPatches) {
        const path = typeof patch.path === "string" ? patch.path : "";
        const nodeId = path.startsWith("/elements/") ? path.slice("/elements/".length) : "";
        if (!planDoc.plan.nodes.some((pn) => pn.id === nodeId)) continue;
        const el = patch.value as { type?: unknown; props?: { content?: unknown } } | undefined;
        if (!el || typeof el !== "object") continue;
        if (el.type !== "TextBlock" && el.type !== "Annotation") continue;
        const content = el.props?.content;
        if (typeof content === "string" && content.trim() === "") emptyPlanNodeIds.add(nodeId);
      }
      for (const node of planDoc.plan.nodes) {
        if (!emptyPlanNodeIds.has(node.id)) continue;
        // Riders untracked here on purpose: this node's first rendering
        // stripped, so its claims' riders never reached the reader.
        const template = realizeNodeTemplate(node, manifestByName);
        const replacement = template?.trim() ? template : null;
        if (replacement) {
          const line = JSON.stringify({
            op: "replace",
            path: `/elements/${node.id}/props/content`,
            value: replacement,
          });
          const finalized = processLine(line);
          if (finalized !== null) {
            emitPatch(finalized);
            proseLintIssues.set(`empty_node_degraded:${node.id}`, {
              kind: "empty_node_degraded",
              detail: `${node.op} node resolved empty — degraded to its deterministic template`,
            });
            logger.warn("Compiled node resolved empty — degraded to template", {
              nodeId: node.id,
              op: node.op,
            });
            continue;
          }
        }
        if (node.op === "ANSWER") {
          logger.error("ANSWER node empty after template degradation", { nodeId: node.id });
          void recordFailure({
            stage: "compose",
            kind: "compose",
            errorClass: "compose_answer_missing",
            detail: `ANSWER ${node.id} resolved empty and no template realization was possible (refs: ${node.refs.join(", ")})`,
          });
          proseLintIssues.set("compose_answer_missing", {
            kind: "no_narrative",
            detail: "the ANSWER resolved empty and could not be re-realized",
          });
        }
      }
    }

    // Warn-only: flag components that read a /computed/<key> nothing produces —
    // they render empty (blank table/map). Tracked in logs, spec left untouched.
    const audit = auditComputedKeys(composedPatches);
    if (audit.unproduced.length > 0) {
      logger.warn("Composed spec reads unproduced computed keys (will render empty)", {
        unproduced: audit.unproduced,
        produced: audit.produced,
      });
    }
  } catch (streamErr) {
    if (!isClosed()) {
      logger.error("Stream error", {
        error: errMessage(streamErr),
      });
      if (lineCount === 0) {
        const errMsg = errMessage(streamErr);
        emit(JSON.stringify({ op: "add", path: "/root", value: "error" }) + "\n");
        emit(
          JSON.stringify({
            op: "add",
            path: "/elements/error",
            value: {
              type: "Annotation",
              props: {
                icon: "alert",
                title: "Analysis Error",
                content: errMsg.includes("too long")
                  ? "The analysis data is too large for the AI to process. Try a more specific question."
                  : errMsg,
                severity: "error",
              },
              children: [],
            },
          }) + "\n"
        );
      }
    }
  }

  // If the LLM streamed state as individual field patches (not a single /state
  // add), we still need to inject the dataset (also when closed, so the assembled
  // spec is complete for history).
  if ((useDataController || sawStateBinding) && !stateInjected && mainDataset) {
    const datasetsPayload: Record<string, unknown> = { main: mainDataset };
    for (const [key, value] of Object.entries(executionResult.chart_data)) {
      if (typeof value === "object" && value !== null) datasetsPayload[key] = value;
    }
    emit(JSON.stringify({ op: "add", path: "/state/datasets", value: datasetsPayload }) + "\n");
  }

  // Grounding (SHARED with Investigate): flag any narrative figure that traces
  // to no computed value, so the same "verify these figures" caveat fires for a
  // single-shot dashboard too. Best-effort; only surfaced when there's an actual
  // ungrounded figure (no steps to cite in single-shot, so silence when clean).
  if (!isClosed()) {
    try {
      const grounded = collectGroundedValues(
        (executionResult.results ?? {}) as Record<string, unknown>,
        (executionResult.chart_data ?? {}) as Record<string, unknown>
      );
      const datasets = executionResult.datasets as Record<string, unknown> | undefined;
      if (datasets) grounded.push(...collectGroundedValues({}, datasets));
      // Declared-findings values are computed results too: compiled-mode
      // narrative binds figures (CI bounds, p-values) that live ONLY in the
      // manifest — without this, the mode built for verifiability wore the
      // loudest "could not be traced" banner (churn-run review: 5 flagged
      // figures, all binding-resolved).
      if (opts.findings) {
        grounded.push(
          ...collectGroundedValues({}, {
            findings: opts.findings.manifest.findings.map((f) => f.value),
          } as Record<string, unknown>)
        );
      }
      // §3.5 question-primary heuristic, deliberately low-noise: the finding
      // tagged "question-primary", else the one whose full name (tokens) the
      // question contains. A miss counts only when the finding is bound in
      // NO StatCard *and* no StatCard binds a $result key sharing its tokens
      // (the tile may legitimately bind the equivalent result scalar).
      let questionPrimaryMiss: string | undefined;
      const declaredEntries = opts.findings?.manifest.findings ?? [];
      if (declaredEntries.length > 0) {
        const q = opts.question.toLowerCase();
        const primary =
          declaredEntries.find((e) => e.tags?.includes("question-primary")) ??
          declaredEntries.find((e) => {
            const tokens = e.name.split("_").filter((t) => t.length > 2);
            return tokens.length > 0 && tokens.every((t) => q.includes(t));
          });
        if (primary && !headlineBound.has(primary.name)) {
          const tokens = primary.name.split("_").filter((t) => t.length > 2);
          const statCardResultKeys = composedPatches
            .filter(
              (p) =>
                p.value &&
                typeof p.value === "object" &&
                (p.value as { type?: unknown }).type === "StatCard"
            )
            .map((p) => JSON.stringify(p.value));
          const coveredByResult = statCardResultKeys.some((json) =>
            tokens.some((t) => json.toLowerCase().includes(t))
          );
          if (!coveredByResult) questionPrimaryMiss = primary.name;
        }
      }

      // Scaffold enforcement, now DETERMINISTIC: a planned tile the composer
      // dropped is INJECTED server-side — the server has both the plan and
      // the values, so a missing required tile needs no model. Injected
      // elements are appended to the first StatCard-bearing grid (or root).
      // Duplicate tiles (same label+value StatCard twice) read as filler.
      const tileSigs = new Map<string, number>();
      for (const p of composedPatches) {
        const val = p.value as { type?: unknown; props?: { label?: unknown; value?: unknown } };
        if (val && typeof val === "object" && val.type === "StatCard") {
          const sig = JSON.stringify([val.props?.label, val.props?.value]);
          tileSigs.set(sig, (tileSigs.get(sig) ?? 0) + 1);
        }
      }
      for (const [sig, n] of tileSigs) {
        if (n > 1) {
          proseLintIssues.set(`duplicate_tile:${sig}`, {
            kind: "duplicate_tile",
            detail: `headline tile ${sig} appears ${n} times`,
          });
        }
      }
      const resolveTileValue = (binding: string): unknown => {
        const m = /^\$(finding|result):(.+)$/.exec(binding);
        if (!m) return undefined;
        const src =
          m[1] === "finding"
            ? findingValues
            : ((executionResult.results ?? {}) as Record<string, unknown>);
        let cur: unknown = src;
        for (const seg of m[2].split(".")) {
          if (cur === null || typeof cur !== "object") return undefined;
          cur = (cur as Record<string, unknown>)[seg];
        }
        return cur;
      };
      const shownTileValues = new Set(
        composedPatches
          .filter(
            (p) =>
              p.value &&
              typeof p.value === "object" &&
              (p.value as { type?: unknown }).type === "StatCard"
          )
          .map((p) => String(((p.value as { props?: { value?: unknown } }).props ?? {}).value))
      );
      const missingTiles = headlinePlan.filter((tile) => {
        if (composedPatches.some((p) => JSON.stringify(p.value ?? {}).includes(tile.binding)))
          return false;
        // Injection dedupe: a tile whose VALUE is already shown under any
        // label is not missing (run-24 injected a duplicate of an existing
        // total under a different label).
        const v = resolveTileValue(tile.binding);
        if (v !== undefined && shownTileValues.has(String(v))) return false;
        return true;
      });
      if (missingTiles.length > 0) {
        const statCardIds = new Set(
          composedPatches
            .filter(
              (p) =>
                p.value &&
                typeof p.value === "object" &&
                (p.value as { type?: unknown }).type === "StatCard" &&
                typeof p.path === "string"
            )
            .map((p) => (p.path as string).split("/").pop() as string)
        );
        const container = composedPatches.find(
          (p) =>
            p.value &&
            typeof p.value === "object" &&
            Array.isArray((p.value as { children?: unknown }).children) &&
            ((p.value as { children: unknown[] }).children as unknown[]).some(
              (id) => typeof id === "string" && statCardIds.has(id)
            )
        );
        if (container && typeof container.path === "string") {
          const containerId = container.path.split("/").pop() as string;
          const oldChildren = (container.value as { children: string[] }).children;
          const injectedIds: string[] = [];
          missingTiles.forEach((tile, i) => {
            const id = `hermetic_injected_tile_${i}`;
            const el = {
              op: "add",
              path: `/elements/${id}`,
              value: {
                type: "StatCard",
                props: {
                  label: tile.label,
                  value: tile.binding,
                  ...(tile.descriptionBinding ? { description: tile.descriptionBinding } : {}),
                },
                children: [],
              },
            };
            const line = processLine(JSON.stringify(el));
            if (line !== null) {
              emitPatch(line);
              injectedIds.push(id);
            }
          });
          if (injectedIds.length > 0) {
            emitPatch(
              JSON.stringify({
                op: "add",
                path: `/elements/${containerId}/children`,
                value: [...oldChildren, ...injectedIds],
              })
            );
            logger.info("Injected missing required headline tiles", {
              tiles: missingTiles.map((t) => t.binding),
            });
          }
        } else {
          for (const tile of missingTiles) {
            proseLintIssues.set(`headline_tile_missing:${tile.binding}`, {
              kind: "headline_tile_missing",
              detail: `required headline tile ${tile.binding} (${tile.reason}) was not composed`,
            });
          }
        }
      }

      // Tier-2 gating (run-36): a failed BLOCKING check that survived the
      // execution retry ships GATED — a server-injected warning at the top
      // of the dashboard, never trusted to prose. Reuses the container
      // attach from tile injection (root element children).
      const shippedBlockingFailures = (opts.findings?.manifest.findings ?? []).filter(
        (f) =>
          f.dtype === "check" &&
          f.tags?.includes("blocking") &&
          f.value !== null &&
          typeof f.value === "object" &&
          (f.value as Record<string, unknown>).passed === false
      );
      if (shippedBlockingFailures.length > 0) {
        const rootPatch = composedPatches.find((p) => p.path === "/root");
        const rootId = typeof rootPatch?.value === "string" ? rootPatch.value : null;
        const rootEl = rootId
          ? composedPatches.find((p) => p.path === `/elements/${rootId}`)
          : undefined;
        const rootChildren = (rootEl?.value as { children?: string[] } | undefined)?.children;
        if (rootId && Array.isArray(rootChildren)) {
          emitPatch(
            JSON.stringify({
              op: "add",
              path: "/elements/hermetic_blocking_gate",
              value: {
                type: "Annotation",
                props: {
                  icon: "alert",
                  severity: "error",
                  title: "A blocking data check failed — treat these results as unvalidated",
                  content: shippedBlockingFailures
                    .map((f) => `${f.name}: ${f.definition}`)
                    .join(" · "),
                },
                children: [],
              },
            })
          );
          emitPatch(
            JSON.stringify({
              op: "add",
              path: `/elements/${rootId}/children`,
              value: ["hermetic_blocking_gate", ...rootChildren],
            })
          );
        }
        for (const f of shippedBlockingFailures) {
          proseLintIssues.set(`blocking_check_shipped:${f.name}`, {
            kind: "blocking_check_shipped",
            name: f.name,
            detail: `blocking check ${f.name} FAILED and the run shipped — results are gated as unvalidated`,
          });
        }
      }

      // Screened superlatives narrated without their raw extreme (the
      // 0.4-vs-26 audit finding): post-resolution narrative scan.
      for (const issue of lintSuperlativeHidesRaw(
        opts.findings?.manifest.findings ?? [],
        narrativeTexts
      )) {
        proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
      }

      // Prose citing a finding the manifest doesn't declare ("the trend
      // (median_price_trend finding) reflects…" with no such finding) —
      // asserted provenance that does not exist. SEVERE: the bounded
      // recompose rewrites or drops the citation.
      for (const issue of lintDanglingFindingReference(
        narrativeTexts,
        opts.findings?.manifest.findings ?? []
      )) {
        proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
      }

      // A dashboard with ZERO narrative elements is not an answer (observed:
      // a sonnet-5 compose emitted 5 tiles + 2 charts and no prose, so the
      // summary every host surface extracts came back empty). Deterministic
      // detection; repaired via the same bounded recompose as other severe
      // narrative defects.
      const PROSE_TYPES = new Set(["TextBlock", "Markdown", "Annotation"]);
      const hasProse = composedPatches.some((p) => {
        const v = p.value as { type?: unknown; props?: { content?: unknown } } | undefined;
        return (
          v !== undefined &&
          typeof v === "object" &&
          PROSE_TYPES.has(String(v.type)) &&
          typeof v.props?.content === "string" &&
          v.props.content.trim().length > 0
        );
      });
      if (!hasProse && lineCount > 0) {
        proseLintIssues.set("no_narrative", {
          kind: "no_narrative",
          detail:
            "the composed dashboard contains NO narrative element — add a TextBlock that answers the question in words, binding the declared findings ($finding:...); tiles and charts alone are not an answer",
        });
      }

      // Bounded recompose (ONE pass): severe narrative defects — null
      // bindings that stripped sentences, unfilled slots — go back to the
      // composer as explicit repair instructions. The recursion re-runs the
      // full compose with fresh state; the new /root supersedes pass 1's
      // elements (orphans are unreferenced and harmless).
      const SEVERE_KINDS = new Set([
        "sentinel_interpolation",
        // A false significance claim is a fabricated verdict (run dfe3ea32:
        // "statistically significant" over significant: false) — repairable.
        "significance_mismatch",
        // A wrong-basis share overstates concentration by construction (run
        // 9c415dc8: a 34.6% count share narrated as "of spend" over a
        // declared 23.5% spend share) — repairable.
        "share_basis_mismatch",
        "zero_count_sentence",
        "empty_interpolation",
        "no_narrative",
        // Provenance asserted for a finding that does not exist — worse
        // than saying no finding is available (MCP deep-dive review).
        "dangling_finding_reference",
      ]);
      const severe = [...proseLintIssues.values()]
        .filter((i) => SEVERE_KINDS.has(i.kind))
        .map((i) => i.detail);
      if (severe.length > 0 && !opts.repairAdvisories && !isClosed()) {
        logger.info("Severe compose advisories — running bounded repair pass", {
          count: severe.length,
        });
        await composeAndStreamDashboard({
          ...args,
          opts: { ...opts, repairAdvisories: severe },
        });
        return;
      }
      // The style this run was ACTUALLY composed with, persisted with the
      // spec (state.__purpose). The header dropdown adopts it on restore —
      // it re-runs the question on change, so a dropdown mislabeling the
      // displayed style costs a full run to "correct". Final pass only
      // (after the bounded-repair recursion decision).
      emit(JSON.stringify({ op: "add", path: "/state/__purpose", value: opts.purpose }) + "\n");
      const report = verifyGrounding({
        narrativeTexts,
        citedSteps: [],
        grounded,
        successfulStepNos: [],
        // String-carrier exemption: numerals embedded in bound string values
        // (payee names, identifiers) are data, not figures.
        stringValues: [
          ...collectStringLeaves(executionResult.results ?? {}),
          ...collectStringLeaves(findingValues),
        ],
        // Enables the directional-contradiction check: a story that denies
        // the engine's own computed trend verdict gets flagged.
        results: (executionResult.results ?? {}) as Record<string, unknown>,
        ...(opts.findings
          ? {
              findings: {
                declared: declaredEntries.map((e) => e.name),
                cited: [...citedFindings],
                issues: [...opts.findings.issues, ...proseLintIssues.values()].map((i) => i.detail),
                questionPrimaryMiss,
              },
            }
          : {}),
      });
      if (!report.ok) {
        emit(JSON.stringify({ op: "add", path: "/state/__grounding", value: report }) + "\n");
      }
      // Verifiability panel (composer-sight spec §2): the mechanical case
      // that the dashboard says what the analysis computed, as a
      // user-reviewable artifact. Always emitted; persisted with the spec.
      // Screens count as checks here (run 31c1cfa9): a surfaced dtype
      // "screen" with passed: false reached the banner and the caveats but
      // not this panel — banner said 3 failures, panel said 2. dtype
      // "outliers" is a declared screen (run d82a39ce).
      const checks = (opts.findings?.manifest.findings ?? []).filter(
        (f) => f.dtype === "check" || f.dtype === "screen" || f.dtype === "outliers"
      );
      // Citation = bound in prose OR referenced by a plan node (run
      // f62eefbb): a narrated NON-DETECTION has nothing to bind — "no
      // persistent step change survived the gates" cites the claim in
      // words via refs, and binding-only counting reported it unnarrated.
      const citationPlanDoc: PlanDocument | null = compiledPlanDoc as PlanDocument | null;
      if (citationPlanDoc) {
        const declaredNames = new Set((opts.findings?.manifest.findings ?? []).map((f) => f.name));
        for (const node of citationPlanDoc.plan.nodes) {
          for (const ref of node.refs) if (declaredNames.has(ref)) citedFindings.add(ref);
        }
      }
      const verifiability = {
        composerSight: opts.sight === "sighted" ? "sighted" : "blind",
        composerMode: compiledMode ? "compiled" : "generative",
        findings: {
          declared: (opts.findings?.manifest.findings ?? []).length,
          cited: citedFindings.size,
          checks: checks.length,
          failedChecks: checks
            .filter((f) => {
              if (f.value === null || typeof f.value !== "object") return false;
              const v = f.value as Record<string, unknown>;
              // Screen semantics for verdict-less screens (dtype "outliers"):
              // offenders found = failed.
              return (
                v.passed === false ||
                (v.passed === undefined && typeof v.n_flagged === "number" && v.n_flagged > 0)
              );
            })
            .map((f) => f.name),
        },
        headline: {
          planned: headlinePlan.map((t) => t.binding),
          injected: [...proseLintIssues.values()].some((i) => i.kind === "headline_tile_missing")
            ? []
            : headlinePlan
                .filter((t) =>
                  composedPatches.some((p) => (p.path as string)?.includes("hermetic_injected"))
                )
                .map((t) => t.binding),
          missing: [...proseLintIssues.values()]
            .filter((i) => i.kind === "headline_tile_missing")
            .map((i) => i.detail),
        },
        prose: {
          issues: [...proseLintIssues.values()].slice(0, 32).map((i) => ({
            kind: i.kind,
            detail: i.detail,
          })),
        },
        grounding: {
          ok: report.ok,
          checkedCount: report.checkedCount,
          ungrounded: report.ungrounded,
          contradictions: report.contradictions ?? [],
        },
      };
      emit(
        JSON.stringify({ op: "add", path: "/state/__verifiability", value: verifiability }) + "\n"
      );
    } catch (err) {
      logger.debug("compose grounding failed (best-effort)", {
        error: errMessage(err),
      });
    }
  }
}
