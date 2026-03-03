import { getRuntimeConfig, setRuntimeConfig, clearRuntimeConfigCache } from "@/lib/runtime-config";
import { clearEnvConfigCache } from "@/lib/config";

export async function GET() {
  const rc = getRuntimeConfig();
  return Response.json({
    ollama: rc.ollama ?? { enabled: false, baseUrl: "http://localhost:11434", activeModel: "" },
  });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { enabled, baseUrl, activeModel } = body;

    const updated = setRuntimeConfig({
      ollama: {
        enabled: enabled ?? false,
        baseUrl: baseUrl || "http://localhost:11434",
        activeModel: activeModel || "",
      },
    });
    clearRuntimeConfigCache();
    clearEnvConfigCache();

    return Response.json({ ollama: updated.ollama });
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
