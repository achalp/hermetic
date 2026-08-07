/**
 * /api/settings route tests: config blocks merge into runtime-config,
 * effective values reflect the settings resolution, API keys go to the
 * keychain seam only (and 422 cleanly when it's absent), and key material
 * never appears in a GET.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rc: {} as Record<string, unknown>,
  keychainOk: true,
  secrets: new Map<string, string>(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: vi.fn(() => state.rc),
  setRuntimeConfig: vi.fn((patch: Record<string, unknown>) => {
    state.rc = { ...state.rc, ...patch };
    return state.rc;
  }),
  getActiveModels: vi.fn(() => ({
    codeGen: "claude-sonnet-4-6",
    uiCompose: "claude-sonnet-4-6",
  })),
}));

vi.mock("@/lib/secrets", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/secrets")>();
  return {
    API_KEY_SECRETS: original.API_KEY_SECRETS,
    keychainAvailable: vi.fn(() => state.keychainOk),
    getSecret: vi.fn((name: string) => state.secrets.get(name)),
    getApiKey: vi.fn((id: keyof typeof original.API_KEY_SECRETS) => {
      const { name, envKey } = original.API_KEY_SECRETS[id];
      return state.secrets.get(name) ?? process.env[envKey] ?? undefined;
    }),
    setSecret: vi.fn((name: string, value: string) => {
      if (!state.keychainOk) throw new Error("hermetic never writes secrets to files");
      if (value === "") state.secrets.delete(name);
      else state.secrets.set(name, value);
    }),
  };
});

import { GET, PUT } from "@/app/api/settings/route";

function putReq(body: unknown): Request {
  return new Request("http://x/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rc = {};
  state.keychainOk = true;
  state.secrets.clear();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

describe("GET /api/settings", () => {
  it("returns config blocks, effective values, and key status — never key material", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-super-secret";
    state.rc = { providers: { openaiModel: "llama3.3" } };
    const body = await GET().json();

    expect(body.config.providers.openaiModel).toBe("llama3.3");
    expect(body.effective.providers.openaiModel).toBe("llama3.3");
    expect(body.api_keys.anthropic).toEqual({ set: true, source: "env" });
    expect(body.keychain_available).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-super-secret");
  });

  it("reports keychain as the source when a stored key exists", async () => {
    state.secrets.set("anthropic-api-key", "sk-keychain");
    const body = await GET().json();
    expect(body.api_keys.anthropic).toEqual({ set: true, source: "keychain" });
    expect(JSON.stringify(body)).not.toContain("sk-keychain");
  });
});

describe("PUT /api/settings", () => {
  it("merges config blocks into runtime-config and echoes the new state", async () => {
    const res = await PUT(
      putReq({
        providers: { openaiBaseUrl: " http://localhost:11434/v1 ", openaiModel: "llama3.3" },
        retention: { maxHistoryEntries: "500" },
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.config.providers.openaiBaseUrl).toBe("http://localhost:11434/v1"); // trimmed
    expect(body.config.retention.maxHistoryEntries).toBe(500); // string coerced
    expect(body.effective.providers.openaiModel).toBe("llama3.3");
  });

  it("clearing a field falls back to the environment value", async () => {
    process.env.OPENAI_BASE_URL = "http://from-env:1/v1";
    state.rc = { providers: { openaiBaseUrl: "http://from-rc:2/v1" } };
    const body = await (await PUT(putReq({ providers: { openaiBaseUrl: "" } }))).json();
    expect(body.config.providers.openaiBaseUrl).toBeUndefined();
    expect(body.effective.providers.openaiBaseUrl).toBe("http://from-env:1/v1");
  });

  it("rejects an out-of-range memory fraction", async () => {
    const res = await PUT(putReq({ sandbox: { memoryFraction: 3 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("memoryFraction");
  });

  it("stores API keys via the keychain seam; a blank deletes", async () => {
    await PUT(putReq({ api_keys: { anthropic: "sk-new" } }));
    expect(state.secrets.get("anthropic-api-key")).toBe("sk-new");

    const body = await PUT(putReq({ api_keys: { anthropic: " " } })).then((r) => r.json());
    expect(state.secrets.has("anthropic-api-key")).toBe(false);
    expect(body.api_keys.anthropic.set).toBe(false);
  });

  it("422s key writes when no credential service exists — never a file fallback", async () => {
    state.keychainOk = false;
    const res = await PUT(putReq({ api_keys: { e2b: "e2b-key" } }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("never writes secrets to files");
    expect(state.secrets.size).toBe(0);
  });

  it("rejects unknown key ids", async () => {
    const res = await PUT(putReq({ api_keys: { evil: "x" } }));
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/settings — models block", () => {
  it("persists a valid selection and rejects unknown ids", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const ok = await PUT(
      new Request("http://x/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          models: { codeGen: "claude-opus-5", uiCompose: "claude-sonnet-5" },
        }),
      })
    );
    expect(ok.status).toBe(200);
    expect((state.rc as { models?: { codeGen?: string } }).models?.codeGen).toBe("claude-opus-5");

    const bad = await PUT(
      new Request("http://x/api/settings", {
        method: "PUT",
        body: JSON.stringify({ models: { codeGen: "gpt-9000" } }),
      })
    );
    expect(bad.status).toBe(400);
  });
});
