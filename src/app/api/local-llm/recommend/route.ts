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

/** Incompatible weight formats — these need specific hardware/tooling */
const INCOMPATIBLE_FORMATS = /FP4|FP8|AWQ|GPTQ|EXL2|AQLM|HQQ/i;

/** Check if a model name/org indicates MLX-compatible weights */
function isMlxCompatible(name: string, quant: string): boolean {
  if (INCOMPATIBLE_FORMATS.test(name)) return false;
  const lower = name.toLowerCase();
  return lower.includes("mlx") || lower.startsWith("mlx-community/") || quant.startsWith("mlx-");
}

/** Check if a model is usable with llama.cpp (GGUF format) */
function isGgufCompatible(
  name: string,
  quant: string,
  ggufSources: Array<{ provider: string; repo: string }>
): boolean {
  if (INCOMPATIBLE_FORMATS.test(name)) return false;
  const lower = name.toLowerCase();
  // Exclude MLX-specific models
  if (lower.includes("mlx") || lower.startsWith("mlx-community/")) return false;
  return (
    ggufSources.length > 0 ||
    lower.includes("gguf") ||
    (/^Q\d/.test(quant) && !quant.startsWith("mlx-")) // GGUF quant like Q4_K_M, Q2_K
  );
}

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
    // Request more results than needed so we have enough after filtering
    const fetchLimit = limit * 4;
    const output = execSync(
      `llmfit recommend --json --use-case coding --force-runtime ${runtime} -n ${fetchLimit}`,
      { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const data = JSON.parse(output);
    const all: LlmfitRecommendation[] = (data.models ?? []).map((m: Record<string, unknown>) => ({
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
    }));

    // Filter to models compatible with the selected backend
    const models = all
      .filter((m) => {
        if (backend === "mlx") return isMlxCompatible(m.name, m.best_quant);
        if (backend === "llama-cpp" || backend === "ollama")
          return isGgufCompatible(m.name, m.best_quant, m.gguf_sources);
        return true;
      })
      .slice(0, limit);

    cache.set(cacheKey, { ts: Date.now(), data: models });
    return Response.json({ models, source: "llmfit" });
  } catch {
    return Response.json({ models: [], source: "fallback", error: "llmfit command failed" });
  }
}
