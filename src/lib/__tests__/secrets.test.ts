/**
 * Secret-store tests: keychain-first resolution, env fallback, and the hard
 * rule that a missing credential service makes writes FAIL rather than fall
 * back to a file.
 */
import { describe, it, expect, beforeEach } from "vitest";

// In-memory keychain fake; `broken` simulates a missing credential service
// (every operation throws, as keyring-rs does without a Secret Service).
// Injected via _setEntryCtorForTests — the native addon loads through
// require(), which vitest module mocks do NOT intercept, and tests must
// never touch the developer's real keychain.
const fake: { broken: boolean; store: Map<string, string> } = {
  broken: false,
  store: new Map(),
};
class FakeEntry {
  constructor(
    private service: string,
    private account: string
  ) {}
  private key() {
    return `${this.service}/${this.account}`;
  }
  getPassword(): string | null {
    if (fake.broken) throw new Error("Platform secure storage failure");
    return fake.store.get(this.key()) ?? null;
  }
  setPassword(v: string): void {
    if (fake.broken) throw new Error("Platform secure storage failure");
    fake.store.set(this.key(), v);
  }
  deleteCredential(): boolean {
    if (fake.broken) throw new Error("Platform secure storage failure");
    return fake.store.delete(this.key());
  }
}

import {
  getSecret,
  setSecret,
  deleteSecret,
  getApiKey,
  keychainAvailable,
  getWarehouseSecrets,
  setWarehouseSecrets,
  _setEntryCtorForTests,
} from "@/lib/secrets";

beforeEach(() => {
  fake.broken = false;
  fake.store.clear();
  _setEntryCtorForTests(FakeEntry as never);
  delete process.env.ANTHROPIC_API_KEY;
});

describe("secret store", () => {
  it("round-trips a secret through the keychain", () => {
    setSecret("test-secret", "s3cr3t");
    expect(getSecret("test-secret")).toBe("s3cr3t");
    deleteSecret("test-secret");
    expect(getSecret("test-secret")).toBeUndefined();
  });

  it("empty value deletes the stored secret", () => {
    setSecret("test-secret", "v");
    setSecret("test-secret", "");
    expect(getSecret("test-secret")).toBeUndefined();
  });

  it("API keys resolve keychain FIRST, env as fallback", () => {
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    expect(getApiKey("anthropic")).toBe("sk-from-env");
    setSecret("anthropic-api-key", "sk-from-keychain");
    expect(getApiKey("anthropic")).toBe("sk-from-keychain");
  });

  it("writes THROW without a credential service — never a file fallback", () => {
    fake.broken = true;
    expect(keychainAvailable()).toBe(false);
    expect(() => setSecret("x", "y")).toThrow(/never writes\s+secrets to files/);
    // Reads still work via env.
    process.env.ANTHROPIC_API_KEY = "sk-env-only";
    expect(getApiKey("anthropic")).toBe("sk-env-only");
  });

  it("availability probe is memoized until reset", () => {
    expect(keychainAvailable()).toBe(true);
    fake.broken = true;
    expect(keychainAvailable()).toBe(true); // memoized
    _setEntryCtorForTests(FakeEntry as never); // re-probe with the fake still in place
    expect(keychainAvailable()).toBe(false);
  });

  it("warehouse blobs round-trip as JSON and survive unparsable blobs", () => {
    setWarehouseSecrets("conn-1", { password: "p", token: "t" });
    expect(getWarehouseSecrets("conn-1")).toEqual({ password: "p", token: "t" });
    fake.store.set("hermetic/warehouse/conn-2", "not-json");
    expect(getWarehouseSecrets("conn-2")).toBeUndefined();
  });
});
