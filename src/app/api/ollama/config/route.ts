import { getRuntimeConfig, setRuntimeConfig, clearRuntimeConfigCache } from "@/lib/runtime-config";
import { DEFAULT_LOCAL_LLM_ENDPOINTS } from "@/lib/constants";
import { clearEnvConfigCache } from "@/lib/config";

export async function GET() {
  const rc = getRuntimeConfig();
  return Response.json({
    ollama: rc.ollama ?? {
      enabled: false,
      baseUrl: DEFAULT_LOCAL_LLM_ENDPOINTS.ollama,
      activeModel: "",
    },
  });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { enabled, baseUrl, activeModel } = body;

    const updated = setRuntimeConfig({
      ollama: {
        enabled: enabled ?? false,
        baseUrl: baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS.ollama,
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
