import { startServer } from "@/lib/llm/process-manager";

export async function POST(request: Request) {
  const body = await request.json();
  const { backend, model, port, modelPath, binaryPath, contextLength } = body;

  if (!backend || !model) {
    return Response.json({ error: "backend and model are required" }, { status: 400 });
  }

  if (backend !== "mlx" && backend !== "llama-cpp") {
    return Response.json({ error: "backend must be mlx or llama-cpp" }, { status: 400 });
  }

  try {
    const result = await startServer(backend, {
      model,
      port,
      modelPath,
      binaryPath,
      contextLength,
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start server";
    return Response.json({ error: message }, { status: 500 });
  }
}
