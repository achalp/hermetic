/**
 * Single-pass Python syntax tokenizer.
 * Returns an array of token objects with type and text,
 * suitable for rendering as React elements (no HTML strings).
 */

const KEYWORDS = new Set([
  "import",
  "from",
  "def",
  "class",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "try",
  "except",
  "finally",
  "with",
  "as",
  "in",
  "not",
  "and",
  "or",
  "is",
  "None",
  "True",
  "False",
  "lambda",
  "yield",
  "raise",
  "pass",
  "break",
  "continue",
  "async",
  "await",
]);

const BUILTINS = new Set([
  "print",
  "len",
  "range",
  "int",
  "float",
  "str",
  "list",
  "dict",
  "set",
  "tuple",
  "type",
  "isinstance",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "sum",
  "min",
  "max",
  "abs",
  "round",
  "open",
]);

// Order matters: earlier alternatives are tried first.
const TOKEN_RE =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[a-zA-Z_]\w*|\d+\.?\d*(?:[eE][+-]?\d+)?|[\s\S]/g;

export type TokenType = "comment" | "string" | "keyword" | "builtin" | "number" | "plain";

export interface SyntaxToken {
  type: TokenType;
  text: string;
}

export function tokenizePython(code: string): SyntaxToken[] {
  return Array.from(code.matchAll(TOKEN_RE)).map(([tok]) => {
    if (tok.startsWith("#")) {
      return { type: "comment" as const, text: tok };
    }
    if (
      tok.startsWith('"') ||
      tok.startsWith("'") ||
      tok.startsWith('"""') ||
      tok.startsWith("'''")
    ) {
      return { type: "string" as const, text: tok };
    }
    if (/^[a-zA-Z_]/.test(tok)) {
      if (KEYWORDS.has(tok)) return { type: "keyword" as const, text: tok };
      if (BUILTINS.has(tok)) return { type: "builtin" as const, text: tok };
      return { type: "plain" as const, text: tok };
    }
    if (/^\d/.test(tok)) {
      return { type: "number" as const, text: tok };
    }
    return { type: "plain" as const, text: tok };
  });
}
