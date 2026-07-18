import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isDotfile,
  isAllowedExtension,
  validateLocalOrigin,
  isPathAllowed,
  allowedLocalRoots,
} from "@/lib/local-files/security";
import { ALLOWED_LOCAL_EXTENSIONS } from "@/lib/constants";

describe("local-files/security", () => {
  describe("isDotfile", () => {
    it("treats names starting with a dot as dotfiles", () => {
      expect(isDotfile(".env")).toBe(true);
      expect(isDotfile(".gitignore")).toBe(true);
      expect(isDotfile(".")).toBe(true);
      expect(isDotfile("..")).toBe(true);
    });

    it("treats normal names as non-dotfiles", () => {
      expect(isDotfile("data.csv")).toBe(false);
      expect(isDotfile("report.parquet")).toBe(false);
      expect(isDotfile("README")).toBe(false);
      expect(isDotfile("")).toBe(false);
    });

    it("only looks at the leading character, not embedded dots", () => {
      expect(isDotfile("my.data.csv")).toBe(false);
      expect(isDotfile("archive.tar.gz")).toBe(false);
    });
  });

  describe("isAllowedExtension", () => {
    it("accepts every extension in the allow-list (lowercase)", () => {
      // Sanity check the allow-list itself is what we expect.
      expect(ALLOWED_LOCAL_EXTENSIONS).toEqual([".parquet", ".csv", ".xlsx", ".geojson", ".json"]);
      for (const ext of ALLOWED_LOCAL_EXTENSIONS) {
        expect(isAllowedExtension(`somefile${ext}`)).toBe(true);
      }
    });

    it("is case-insensitive", () => {
      expect(isAllowedExtension("DATA.CSV")).toBe(true);
      expect(isAllowedExtension("Report.Parquet")).toBe(true);
      expect(isAllowedExtension("SHEET.XLSX")).toBe(true);
      expect(isAllowedExtension("map.GeoJSON")).toBe(true);
    });

    it("rejects disallowed extensions", () => {
      expect(isAllowedExtension("malware.exe")).toBe(false);
      expect(isAllowedExtension("script.sh")).toBe(false);
      expect(isAllowedExtension("notes.txt")).toBe(false);
      expect(isAllowedExtension("archive.zip")).toBe(false);
    });

    it("rejects names with no extension", () => {
      expect(isAllowedExtension("README")).toBe(false);
      expect(isAllowedExtension("data")).toBe(false);
      expect(isAllowedExtension("")).toBe(false);
    });

    it("matches the final extension even with multiple dots", () => {
      expect(isAllowedExtension("my.data.csv")).toBe(true);
      // .json is allowed and is the suffix here
      expect(isAllowedExtension("backup.2024.json")).toBe(true);
      // a disallowed final extension is rejected even if an allowed token appears earlier
      expect(isAllowedExtension("data.csv.exe")).toBe(false);
    });

    it("uses suffix matching: a bare allowed extension as the whole name still matches", () => {
      // ".csv" ends with ".csv"
      expect(isAllowedExtension(".csv")).toBe(true);
    });
  });

  describe("isPathAllowed (root-jail)", () => {
    afterEach(() => {
      delete process.env.HERMETIC_LOCAL_FILE_ROOTS;
    });

    it("allows the home dir and its descendants", () => {
      expect(isPathAllowed(homedir())).toBe(true);
      expect(isPathAllowed(join(homedir(), "data", "sales.csv"))).toBe(true);
    });

    it("rejects paths outside every root (/etc, another user's home)", () => {
      expect(isPathAllowed("/etc")).toBe(false);
      expect(isPathAllowed("/etc/passwd")).toBe(false);
      expect(isPathAllowed("/")).toBe(false);
    });

    it("is not fooled by a prefix-escape sibling (e.g. /Users/xevil vs /Users/x)", () => {
      expect(isPathAllowed(homedir() + "evil")).toBe(false);
    });

    it("HERMETIC_LOCAL_FILE_ROOTS extends the jail", () => {
      expect(isPathAllowed("/Volumes/data/x.parquet")).toBe(false);
      process.env.HERMETIC_LOCAL_FILE_ROOTS = "/Volumes/data";
      expect(isPathAllowed("/Volumes/data/x.parquet")).toBe(true);
      expect(allowedLocalRoots()).toContain("/Volumes/data");
      // other outside paths remain rejected
      expect(isPathAllowed("/Volumes/other/x.parquet")).toBe(false);
    });
  });

  describe("validateLocalOrigin", () => {
    const make = (headers: Record<string, string>) =>
      new Request("http://localhost:3000/api/local-files", { headers });

    it("with no Origin, falls back to the Host header (fail closed)", () => {
      // Same-origin GETs and curl carry no Origin but always carry Host —
      // requiring a loopback Host defeats DNS rebinding via a hostname the
      // attacker controls, without breaking local tools.
      expect(validateLocalOrigin(make({ host: "localhost:3000" }))).toBe(true);
      expect(validateLocalOrigin(make({ host: "127.0.0.1:3000" }))).toBe(true);
      expect(validateLocalOrigin(make({ host: "rebind.evil.com" }))).toBe(false);
      // Neither header at all → reject (previously this was allowed).
      expect(validateLocalOrigin(make({}))).toBe(false);
    });

    it("allows a localhost Origin", () => {
      expect(validateLocalOrigin(make({ origin: "http://localhost:3000" }))).toBe(true);
      expect(validateLocalOrigin(make({ origin: "https://localhost" }))).toBe(true);
    });

    it("allows a 127.0.0.1 Origin", () => {
      expect(validateLocalOrigin(make({ origin: "http://127.0.0.1:3000" }))).toBe(true);
      expect(validateLocalOrigin(make({ origin: "http://127.0.0.1" }))).toBe(true);
    });

    it("rejects an external Origin (DNS rebinding / cross-site)", () => {
      expect(validateLocalOrigin(make({ origin: "http://evil.com" }))).toBe(false);
      expect(validateLocalOrigin(make({ origin: "https://attacker.example:443" }))).toBe(false);
      // A hostname that merely contains localhost is not the localhost host.
      expect(validateLocalOrigin(make({ origin: "http://localhost.evil.com" }))).toBe(false);
      // IPv6 loopback is not in the allow-list.
      expect(validateLocalOrigin(make({ origin: "http://[::1]:3000" }))).toBe(false);
    });

    it("rejects a malformed/unparseable Origin value", () => {
      expect(validateLocalOrigin(make({ origin: "not a url" }))).toBe(false);
      expect(validateLocalOrigin(make({ origin: "localhost:3000" }))).toBe(false);
    });

    it("ignores the Referer header — only Origin is consulted", () => {
      // External Origin still rejected even with a localhost Referer.
      expect(
        validateLocalOrigin(make({ origin: "http://evil.com", referer: "http://localhost:3000/" }))
      ).toBe(false);
    });
  });
});
