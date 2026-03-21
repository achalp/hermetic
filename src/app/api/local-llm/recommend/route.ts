import { execSync } from "child_process";

export interface LlmfitRecommendation {
  name: string;
  provider: string;
  score: number;
  best_quant: string;
  fit_level: string;
  memory_required_gb: number;
  estimated_tps: number;
  parameter_count: string;
  use_case: string;
  category: string;
  context_length: number;
  gguf_sources: Array<{ provider: string; repo: string }>;
}

const RUNTIME_MAP: Record<string, string> = {
  mlx: "mlx",
  "llama-cpp": "llamacpp",
  ollama: "llamacpp", // llmfit doesn't have a separate ollama runtime
};

/** Cache results per backend for 5 minutes to avoid repeated shell calls */
const cache = new Map<string, { ts: number; data: LlmfitRecommendation[] }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const backend = searchParams.get("backend") ?? "mlx";
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "8", 10), 20);

  const cacheKey = `${backend}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return Response.json({ models: cached.data, source: "llmfit", cached: true });
  }

  const runtime = RUNTIME_MAP[backend] ?? "llamacpp";

  try {
    // Check if llmfit is available
    execSync("which llmfit", { stdio: "ignore" });
  } catch {
    return Response.json({ models: [], source: "fallback", error: "llmfit not installed" });
  }

  try {
    const output = execSync(
      `llmfit recommend --json --use-case coding --force-runtime ${runtime} -n ${limit}`,
      { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const data = JSON.parse(output);
    const models: LlmfitRecommendation[] = (data.models ?? []).map(
      (m: Record<string, unknown>) => ({
        name: m.name as string,
        provider: m.provider as string,
        score: m.score as number,
        best_quant: m.best_quant as string,
        fit_level: m.fit_level as string,
        memory_required_gb: m.memory_required_gb as number,
        estimated_tps: m.estimated_tps as number,
        parameter_count: m.parameter_count as string,
        use_case: m.use_case as string,
        category: m.category as string,
        context_length: m.context_length as number,
        gguf_sources: (m.gguf_sources as Array<{ provider: string; repo: string }>) ?? [],
      })
    );

    cache.set(cacheKey, { ts: Date.now(), data: models });
    return Response.json({ models, source: "llmfit" });
  } catch {
    return Response.json({ models: [], source: "fallback", error: "llmfit command failed" });
  }
}
