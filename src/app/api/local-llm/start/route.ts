import { startServer } from "@/lib/llm/process-manager";

export async function POST(request: Request) {
  const body = await request.json();
  const { backend, model, port, modelPath, binaryPath, contextLength } = body;

  if (!backend || !model) {
    return Response.json({ error: "backend and model are required" }, { status: 400 });
  }

  if (backend !== "mlx" && backend !== "llama-cpp" && backend !== "ollama") {
    return Response.json({ error: "backend must be mlx, llama-cpp, or ollama" }, { status: 400 });
  }

  try {
    const result = await startServer(backend, {
      model,
      port,
      modelPath,
      binaryPath,
      contextLength,
    });
    // Server is spawned but may still be loading the model.
    // Client should poll /api/local-llm/status?backend=... until healthy.
    return Response.json({ success: true, status: "starting", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start server";
    return Response.json({ error: message }, { status: 500 });
  }
}
