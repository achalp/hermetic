import { getActiveProvider } from "@/lib/llm/client";
import { AVAILABLE_PROVIDERS } from "@/lib/constants";
import type { LLMProviderId } from "@/lib/constants";
import { getRuntimeConfig, setRuntimeConfig } from "@/lib/runtime-config";

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

export async function PUT(request: Request) {
  const body = await request.json();
  const { provider } = body;

  if (!provider) {
    return Response.json({ error: "provider is required" }, { status: 400 });
  }

  const validProviders = AVAILABLE_PROVIDERS.map((p) => p.id);
  if (!validProviders.includes(provider)) {
    return Response.json({ error: `Invalid provider: ${provider}` }, { status: 400 });
  }

  // Save the user's provider preference
  setRuntimeConfig({ activeProvider: provider });

  // Re-read to confirm
  const active = getActiveProvider();
  const activeInfo = AVAILABLE_PROVIDERS.find((p) => p.id === active);

  return Response.json({
    active,
    activeLabel: activeInfo?.label ?? active,
  });
}
