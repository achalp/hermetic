import { getRuntimeConfig, setRuntimeConfig, clearRuntimeConfigCache } from "@/lib/runtime-config";
import { clearEnvConfigCache } from "@/lib/config";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const backend = searchParams.get("backend") ?? "mlx";
  const rc = getRuntimeConfig();

  if (backend === "ollama") {
    return Response.json({
      config: rc.ollama ?? { enabled: false, baseUrl: "http://localhost:11434", activeModel: "" },
    });
  }
  if (backend === "mlx") {
    return Response.json({
      config: rc.mlx ?? { enabled: false, baseUrl: "http://localhost:8080", activeModel: "" },
    });
  }
  if (backend === "llama-cpp") {
    return Response.json({
      config: rc.llamaCpp ?? { enabled: false, baseUrl: "http://localhost:8081", activeModel: "" },
    });
  }
  return Response.json({ error: "Unknown backend" }, { status: 400 });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { backend, enabled, baseUrl, activeModel } = body;

    if (backend === "ollama") {
      const updated = setRuntimeConfig({
        ollama: {
          enabled: enabled ?? false,
          baseUrl: baseUrl || "http://localhost:11434",
          activeModel: activeModel || "",
        },
      });
      clearRuntimeConfigCache();
      clearEnvConfigCache();
      return Response.json({ config: updated.ollama });
    }

    if (backend === "mlx") {
      const updated = setRuntimeConfig({
        mlx: {
          enabled: enabled ?? false,
          baseUrl: baseUrl || "http://localhost:8080",
          activeModel: activeModel || "",
        },
      });
      clearRuntimeConfigCache();
      clearEnvConfigCache();
      return Response.json({ config: updated.mlx });
    }

    if (backend === "llama-cpp") {
      const updated = setRuntimeConfig({
        llamaCpp: {
          enabled: enabled ?? false,
          baseUrl: baseUrl || "http://localhost:8081",
          activeModel: activeModel || "",
        },
      });
      clearRuntimeConfigCache();
      clearEnvConfigCache();
      return Response.json({ config: updated.llamaCpp });
    }

    return Response.json({ error: "Unknown backend" }, { status: 400 });
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
