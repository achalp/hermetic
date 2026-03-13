import { getActiveProvider } from "@/lib/llm/client";
import { AVAILABLE_PROVIDERS } from "@/lib/constants";
import type { LLMProviderId } from "@/lib/constants";
import { getRuntimeConfig } from "@/lib/runtime-config";

export function GET() {
  let active: LLMProviderId;
  try {
    active = getActiveProvider();
  } catch {
    return Response.json({ error: "No LLM provider configured" }, { status: 500 });
  }

  const configured: LLMProviderId[] = [];
  if (process.env.ANTHROPIC_API_KEY) configured.push("anthropic");
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) configured.push("bedrock");
  if (process.env.GOOGLE_VERTEX_PROJECT) configured.push("vertex");
  if (process.env.OPENAI_BASE_URL) configured.push("openai-compatible");

  const rc = getRuntimeConfig();
  if (rc.mlx?.enabled) configured.push("mlx");
  if (rc.llamaCpp?.enabled) configured.push("llama-cpp");
  if (rc.ollama?.enabled) configured.push("ollama");

  const activeInfo = AVAILABLE_PROVIDERS.find((p) => p.id === active);

  let model: string | undefined;
  if (active === "openai-compatible") model = process.env.OPENAI_MODEL ?? "unknown";
  else if (active === "mlx") model = rc.mlx?.activeModel ?? "unknown";
  else if (active === "llama-cpp") model = rc.llamaCpp?.activeModel ?? "unknown";
  else if (active === "ollama") model = rc.ollama?.activeModel ?? "unknown";

  return Response.json({
    active,
    activeLabel: activeInfo?.label ?? active,
    configured,
    ...(model && { model }),
  });
}
