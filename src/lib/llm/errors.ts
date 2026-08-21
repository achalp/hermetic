/**
 * Classification of LLM provider errors that pipeline surfaces rewrite into
 * user-facing guidance.
 */

/**
 * True when an error message is a PROVIDER context-length overflow — the case
 * the UI rewrites to "the analysis data is too large for the AI".
 *
 * Scoped to the wordings the transports actually produce (Anthropic API:
 * "prompt is too long: N tokens > M maximum", "input length and max_tokens
 * exceed context limit"; OpenAI-compatible local servers: "maximum context
 * length", "context_length_exceeded"). A bare `includes("too long")` also
 * matched data-layer errors like Postgres "value too long for type
 * character varying(40)" and rewrote them into a misleading "data too large
 * for the AI" message that sent users trimming questions instead of fixing
 * their schema.
 */
export function isContextLengthError(message: string): boolean {
  return (
    /prompt is too long/i.test(message) ||
    /input length and .?max_tokens.? exceed context limit/i.test(message) ||
    /maximum context length/i.test(message) ||
    /context[_ ](?:length|window)[_ ]?exceeded/i.test(message)
  );
}
