/**
 * /api/settings — the Settings UI's read/write surface for the config blocks
 * introduced by the secrets-and-settings migration (spec 2026-08-06):
 *
 *   GET  → { config, effective, api_keys, keychain_available }
 *     config:     the runtime-config blocks verbatim (what the UI edits)
 *     effective:  the RESOLVED values (runtime-config → env) so the UI can
 *                 show env-derived fallbacks as placeholders
 *     api_keys:   which keys are SET and where from ("keychain" | "env") —
 *                 never the key material itself
 *
 *   PUT  → partial update:
 *     { providers?, sandbox?, retention? }  → merged into runtime-config
 *     { api_keys?: { anthropic?, openai?, e2b?, microsandbox? } }
 *         → OS keychain only ("" deletes). 422 when no credential service
 *           exists — secrets are never written to files.
 */
import {
  getRuntimeConfig,
  setRuntimeConfig,
  getActiveModels,
  getActiveSandboxRuntime,
  type RuntimeConfig,
} from "@/lib/runtime-config";
import {
  openaiBaseUrl,
  openaiModel,
  vertexProject,
  vertexLocation,
  awsRegion,
  microsandboxUrl,
  microsandboxImage,
  sandboxMemoryFraction,
  maxHistoryEntries,
  maxRunRecords,
} from "@/lib/settings";
import {
  API_KEY_SECRETS,
  getApiKey,
  getSecret,
  setSecret,
  keychainAvailable,
  type ApiKeyId,
} from "@/lib/secrets";
import { DEFAULT_SANDBOX_MEMORY_FRACTION, isValidModelId } from "@/lib/constants";

import { errMessage } from "@/lib/logger";
const DEFAULT_MAX_HISTORY = 200;
const DEFAULT_MAX_RUNS = 200;

function apiKeyStatus(): Record<ApiKeyId, { set: boolean; source: "keychain" | "env" | null }> {
  const out = {} as Record<ApiKeyId, { set: boolean; source: "keychain" | "env" | null }>;
  for (const id of Object.keys(API_KEY_SECRETS) as ApiKeyId[]) {
    const fromKeychain = getSecret(API_KEY_SECRETS[id].name);
    const resolved = getApiKey(id);
    out[id] = {
      set: !!resolved,
      source: fromKeychain ? "keychain" : resolved ? "env" : null,
    };
  }
  return out;
}

export function GET() {
  const rc = getRuntimeConfig();
  return Response.json({
    config: {
      providers: rc.providers ?? {},
      sandbox: rc.sandbox ?? {},
      retention: rc.retention ?? {},
      models: rc.models ?? {},
      composer: rc.composer ?? {},
    },
    effective: {
      providers: {
        openaiBaseUrl: openaiBaseUrl() ?? null,
        openaiModel: openaiModel() ?? null,
        vertexProject: vertexProject() ?? null,
        vertexLocation: vertexLocation() ?? null,
        awsRegion: awsRegion() ?? null,
      },
      sandbox: {
        microsandboxUrl: microsandboxUrl() ?? null,
        microsandboxImage: microsandboxImage() ?? null,
        memoryFraction: sandboxMemoryFraction(DEFAULT_SANDBOX_MEMORY_FRACTION),
        runtime: getActiveSandboxRuntime(),
      },
      retention: {
        maxHistoryEntries: maxHistoryEntries(DEFAULT_MAX_HISTORY),
        maxRunRecords: maxRunRecords(DEFAULT_MAX_RUNS),
      },
      models: getActiveModels(),
    },
    api_keys: apiKeyStatus(),
    keychain_available: keychainAvailable(),
  });
}

/** Trimmed string or undefined; empty string clears the field (→ env fallback). */
function cleanString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function cleanNumber(v: unknown, ok: (n: number) => boolean): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && ok(n) ? n : undefined;
}

export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate the ENTIRE body BEFORE any side effect, so the request is
  // all-or-nothing: a valid api key alongside an invalid model block must NOT
  // persist the key and then 400. Keychain writes and the runtime-config write
  // both happen only in the apply phase at the end.

  // ── API keys → validate shape now, write in the apply phase ──
  const keys = body.api_keys as Partial<Record<ApiKeyId, unknown>> | undefined;
  const keyWrites: { name: string; value: string }[] = [];
  if (keys) {
    for (const [id, value] of Object.entries(keys)) {
      if (!(id in API_KEY_SECRETS)) {
        return Response.json({ error: `Unknown api key id: ${id}` }, { status: 400 });
      }
      if (typeof value !== "string") {
        return Response.json({ error: `api_keys.${id} must be a string` }, { status: 400 });
      }
      keyWrites.push({ name: API_KEY_SECRETS[id as ApiKeyId].name, value: value.trim() });
    }
  }

  // ── Config blocks → runtime-config (validated, partial merge) ──
  const patch: Partial<RuntimeConfig> = {};
  const rc = getRuntimeConfig();

  if (body.providers !== undefined) {
    const p = (body.providers ?? {}) as Record<string, unknown>;
    patch.providers = {
      ...rc.providers,
      openaiBaseUrl: cleanString(p.openaiBaseUrl),
      openaiModel: cleanString(p.openaiModel),
      vertexProject: cleanString(p.vertexProject),
      vertexLocation: cleanString(p.vertexLocation),
      awsRegion: cleanString(p.awsRegion),
    };
  }
  if (body.sandbox !== undefined) {
    const s = (body.sandbox ?? {}) as Record<string, unknown>;
    const fraction = cleanNumber(s.memoryFraction, (n) => n > 0 && n <= 1);
    if (s.memoryFraction !== undefined && s.memoryFraction !== "" && fraction === undefined) {
      return Response.json(
        { error: "sandbox.memoryFraction must be a number in (0, 1]" },
        { status: 400 }
      );
    }
    patch.sandbox = {
      ...rc.sandbox,
      microsandboxUrl: cleanString(s.microsandboxUrl),
      microsandboxImage: cleanString(s.microsandboxImage),
      memoryFraction: fraction,
    };
  }
  if (body.retention !== undefined) {
    const r = (body.retention ?? {}) as Record<string, unknown>;
    const hist = cleanNumber(r.maxHistoryEntries, (n) => n >= 1);
    const runs = cleanNumber(r.maxRunRecords, (n) => n >= 1);
    if (r.maxHistoryEntries !== undefined && r.maxHistoryEntries !== "" && hist === undefined) {
      return Response.json(
        { error: "retention.maxHistoryEntries must be a positive number" },
        { status: 400 }
      );
    }
    if (r.maxRunRecords !== undefined && r.maxRunRecords !== "" && runs === undefined) {
      return Response.json(
        { error: "retention.maxRunRecords must be a positive number" },
        { status: 400 }
      );
    }
    patch.retention = {
      ...rc.retention,
      maxHistoryEntries: hist ? Math.floor(hist) : undefined,
      maxRunRecords: runs ? Math.floor(runs) : undefined,
    };
  }
  if (body.models !== undefined) {
    const m = (body.models ?? {}) as Record<string, unknown>;
    const codeGen = cleanString(m.codeGen);
    const uiCompose = cleanString(m.uiCompose);
    const LEVELS = ["auto", "low", "medium", "high", "xhigh", "max"];
    const effort = cleanString(m.effort);
    if (effort !== undefined && !LEVELS.includes(effort)) {
      return Response.json({ error: `Unknown effort level: ${effort}` }, { status: 400 });
    }
    let efforts: Record<string, string> | undefined;
    if (m.efforts !== undefined && m.efforts !== null) {
      if (typeof m.efforts !== "object" || Array.isArray(m.efforts)) {
        return Response.json({ error: "models.efforts must be an object" }, { status: 400 });
      }
      efforts = {};
      for (const [phase, level] of Object.entries(m.efforts as Record<string, unknown>)) {
        if (typeof level !== "string" || !LEVELS.includes(level)) {
          return Response.json(
            { error: `Unknown effort level for ${phase}: ${String(level)}` },
            { status: 400 }
          );
        }
        if (level !== "auto") efforts[phase] = level; // "auto" clears the phase
      }
    }
    if (codeGen !== undefined && !isValidModelId(codeGen)) {
      return Response.json({ error: `Unknown model id: ${codeGen}` }, { status: 400 });
    }
    if (uiCompose !== undefined && !isValidModelId(uiCompose)) {
      return Response.json({ error: `Unknown model id: ${uiCompose}` }, { status: 400 });
    }
    // PARTIAL update: a field ABSENT from the request keeps its stored value;
    // an explicit "" clears it (cleanString collapses both to undefined, so
    // distinguish on the raw body). The old unconditional `codeGen,` spread
    // wrote undefined over the stored model on every efforts-only save —
    // which silently erased the cross-harness model selection and forked the
    // web (localStorage) and MCP (runtime-config default) onto different
    // models.
    const merged: NonNullable<RuntimeConfig["models"]> = { ...rc.models };
    const applyField = (key: "codeGen" | "uiCompose" | "effort", raw: unknown, v?: string) => {
      if (raw === undefined) return; // absent → keep stored
      if (v === undefined)
        delete merged[key]; // "" → clear
      else merged[key] = v;
    };
    applyField("codeGen", m.codeGen, codeGen);
    applyField("uiCompose", m.uiCompose, uiCompose);
    applyField("effort", m.effort, effort);
    if (efforts !== undefined) merged.efforts = efforts;
    patch.models = merged;
  }
  if (body.composer !== undefined) {
    const c = (body.composer ?? {}) as Record<string, unknown>;
    const mode = cleanString(c.mode);
    if (mode !== undefined && mode !== "generative" && mode !== "compiled") {
      return Response.json({ error: `Unknown composer mode: ${mode}` }, { status: 400 });
    }
    const mergedComposer = { ...rc.composer };
    if (c.mode !== undefined) {
      if (mode === undefined)
        delete mergedComposer.mode; // "" clears
      else mergedComposer.mode = mode;
    }
    patch.composer = mergedComposer;
  }
  // ── Apply phase: every block validated above — now the side effects. Keys
  // first (a keychain failure 422s before runtime-config is touched), then the
  // config write. ──
  for (const { name, value } of keyWrites) {
    try {
      setSecret(name, value);
    } catch (err) {
      return Response.json({ error: errMessage(err) }, { status: 422 });
    }
  }
  if (Object.keys(patch).length > 0) setRuntimeConfig(patch);

  return GET();
}
