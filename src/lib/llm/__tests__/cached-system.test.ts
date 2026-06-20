import { describe, it, expect, vi } from "vitest";

// Control the active provider that cachedSystem reads via getActiveProvider.
const rc: { activeProvider: string } = { activeProvider: "anthropic" };
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => rc,
}));

import { cachedSystem, cachedText } from "@/lib/llm/client";
import type { SystemModelMessage } from "ai";

describe("cachedSystem", () => {
  it("wraps the prompt with ephemeral cacheControl for the anthropic provider", () => {
    rc.activeProvider = "anthropic";
    const result = cachedSystem("SYSTEM PROMPT");
    expect(typeof result).toBe("object");
    const msg = result as SystemModelMessage;
    expect(msg.role).toBe("system");
    expect(msg.content).toBe("SYSTEM PROMPT");
    expect(msg.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("returns a plain string (no caching) for non-anthropic providers", () => {
    rc.activeProvider = "ollama";
    expect(cachedSystem("SYSTEM PROMPT")).toBe("SYSTEM PROMPT");
  });
});

describe("cachedText", () => {
  it("returns a text part with ephemeral cacheControl for anthropic", () => {
    rc.activeProvider = "anthropic";
    const part = cachedText("SCHEMA BLOCK");
    expect(part.type).toBe("text");
    expect(part.text).toBe("SCHEMA BLOCK");
    expect(part.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("returns a plain text part (no cacheControl) for non-anthropic providers", () => {
    rc.activeProvider = "ollama";
    const part = cachedText("SCHEMA BLOCK");
    expect(part).toEqual({ type: "text", text: "SCHEMA BLOCK" });
    expect(part.providerOptions).toBeUndefined();
  });
});
