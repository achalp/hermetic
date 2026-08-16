import { getActiveProvider } from "@/lib/llm/client";
import { errMessage } from "@/lib/logger";
import { isClaudeCliAvailable } from "@/lib/llm/claude-cli-transport";
import { AVAILABLE_PROVIDERS } from "@/lib/constants";
import type { LLMProviderId } from "@/lib/constants";
import { getRuntimeConfig, setRuntimeConfig } from "@/lib/runtime-config";
import { openaiBaseUrl, openaiModel, vertexProject } from "@/lib/settings";
import { getApiKey, setSecret, keychainAvailable, API_KEY_SECRETS } from "@/lib/secrets";

export function GET() {
  let active: LLMProviderId;
  try {
    active = getActiveProvider();
  } catch {
    return Response.json({ error: "No LLM provider configured" }, { status: 500 });
  }

  const rc = getRuntimeConfig();

  const configured: LLMProviderId[] = [];
  if (getApiKey("anthropic")) configured.push("anthropic");
  if (isClaudeCliAvailable(rc.claudeCli?.binaryPath)) configured.push("claude-cli");
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) configured.push("bedrock");
  if (vertexProject()) configured.push("vertex");
  if (openaiBaseUrl()) configured.push("openai-compatible");

  if (rc.mlx?.enabled) configured.push("mlx");
  if (rc.llamaCpp?.enabled) configured.push("llama-cpp");
  if (rc.ollama?.enabled) configured.push("ollama");

  const activeInfo = AVAILABLE_PROVIDERS.find((p) => p.id === active);

  let model: string | undefined;
  if (active === "openai-compatible") model = openaiModel() ?? "unknown";
  else if (active === "mlx") model = rc.mlx?.activeModel ?? "unknown";
  else if (active === "llama-cpp") model = rc.llamaCpp?.activeModel ?? "unknown";
  else if (active === "ollama") model = rc.ollama?.activeModel ?? "unknown";

  return Response.json({
    active,
    activeLabel: activeInfo?.label ?? active,
    configured,
    // Whether "add key in Settings" is possible on this system (OS keychain).
    keychain_available: keychainAvailable(),
    ...(model && { model }),
  });
}

export async function PUT(request: Request) {
  const body = await request.json();
  const { provider, api_key } = body;

  if (!provider) {
    return Response.json({ error: "provider is required" }, { status: 400 });
  }

  const validProviders = AVAILABLE_PROVIDERS.map((p) => p.id);
  if (!validProviders.includes(provider)) {
    return Response.json({ error: `Invalid provider: ${provider}` }, { status: 400 });
  }

  // Optional API key: stored ONLY in the OS keychain (never a file). An
  // empty string deletes the stored key.
  if (typeof api_key === "string") {
    const keyId =
      provider === "anthropic" ? "anthropic" : provider === "openai-compatible" ? "openai" : null;
    if (!keyId) {
      return Response.json(
        { error: `Provider ${provider} does not take an API key here.` },
        { status: 400 }
      );
    }
    try {
      setSecret(API_KEY_SECRETS[keyId].name, api_key);
    } catch (err) {
      return Response.json({ error: errMessage(err) }, { status: 422 });
    }
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
