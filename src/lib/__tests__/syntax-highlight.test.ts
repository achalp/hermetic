import { describe, it, expect } from "vitest";
import { tokenizePython, type SyntaxToken } from "@/lib/syntax-highlight";

function types(tokens: SyntaxToken[]) {
  return tokens.map((t) => t.type);
}

function texts(tokens: SyntaxToken[]) {
  return tokens.map((t) => t.text);
}

describe("tokenizePython", () => {
  it("tokenizes a simple assignment", () => {
    const tokens = tokenizePython("x = 42");
    expect(texts(tokens)).toEqual(["x", " ", "=", " ", "42"]);
    expect(types(tokens)).toEqual(["plain", "plain", "plain", "plain", "number"]);
  });

  it("identifies keywords", () => {
    const tokens = tokenizePython("import pandas as pd");
    const kws = tokens.filter((t) => t.type === "keyword");
    expect(kws.map((t) => t.text)).toEqual(["import", "as"]);
  });

  it("identifies builtins", () => {
    const tokens = tokenizePython("print(len(x))");
    const builtins = tokens.filter((t) => t.type === "builtin");
    expect(builtins.map((t) => t.text)).toEqual(["print", "len"]);
  });

  it("identifies single-line comments", () => {
    const tokens = tokenizePython("x = 1 # a comment");
    const comments = tokens.filter((t) => t.type === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("# a comment");
  });

  it("identifies double-quoted strings", () => {
    const tokens = tokenizePython('name = "hello"');
    const strings = tokens.filter((t) => t.type === "string");
    expect(strings).toHaveLength(1);
    expect(strings[0].text).toBe('"hello"');
  });

  it("identifies single-quoted strings", () => {
    const tokens = tokenizePython("name = 'world'");
    const strings = tokens.filter((t) => t.type === "string");
    expect(strings).toHaveLength(1);
    expect(strings[0].text).toBe("'world'");
  });

  it("identifies triple-quoted strings", () => {
    const tokens = tokenizePython('s = """multi\nline"""');
    const strings = tokens.filter((t) => t.type === "string");
    expect(strings).toHaveLength(1);
    expect(strings[0].text).toBe('"""multi\nline"""');
  });

  it("identifies numbers with decimals and exponents", () => {
    const tokens = tokenizePython("3.14 1e10 42");
    const nums = tokens.filter((t) => t.type === "number");
    expect(nums.map((t) => t.text)).toEqual(["3.14", "1e10", "42"]);
  });

  it("round-trips: concatenated text equals original code", () => {
    const code = "def foo(x):\n    return x * 2  # double\n\nprint(foo(21))";
    const tokens = tokenizePython(code);
    expect(tokens.map((t) => t.text).join("")).toBe(code);
  });

  it("handles empty string", () => {
    expect(tokenizePython("")).toEqual([]);
  });

  it("handles strings with escaped quotes", () => {
    const tokens = tokenizePython('"he said \\"hi\\""');
    const strings = tokens.filter((t) => t.type === "string");
    expect(strings).toHaveLength(1);
  });
});
