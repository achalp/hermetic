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

  // ── API keys → keychain only ──
  const keys = body.api_keys as Partial<Record<ApiKeyId, unknown>> | undefined;
  if (keys) {
    for (const [id, value] of Object.entries(keys)) {
      if (!(id in API_KEY_SECRETS)) {
        return Response.json({ error: `Unknown api key id: ${id}` }, { status: 400 });
      }
      if (typeof value !== "string") {
        return Response.json({ error: `api_keys.${id} must be a string` }, { status: 400 });
      }
      try {
        setSecret(API_KEY_SECRETS[id as ApiKeyId].name, value.trim());
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 422 }
        );
      }
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
    const effort = cleanString(m.effort);
    if (effort !== undefined && !["auto", "low", "medium", "high"].includes(effort)) {
      return Response.json({ error: `Unknown effort level: ${effort}` }, { status: 400 });
    }
    if (codeGen !== undefined && !isValidModelId(codeGen)) {
      return Response.json({ error: `Unknown model id: ${codeGen}` }, { status: 400 });
    }
    if (uiCompose !== undefined && !isValidModelId(uiCompose)) {
      return Response.json({ error: `Unknown model id: ${uiCompose}` }, { status: 400 });
    }
    patch.models = { ...rc.models, codeGen, uiCompose, effort };
  }
  if (Object.keys(patch).length > 0) setRuntimeConfig(patch);

  return GET();
}
