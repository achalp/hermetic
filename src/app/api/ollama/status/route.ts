import { getRuntimeConfig } from "@/lib/runtime-config";
import { DEFAULT_LOCAL_LLM_ENDPOINTS } from "@/lib/constants";

export async function GET() {
  const rc = getRuntimeConfig();
  const baseUrl = rc.ollama?.baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS.ollama;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${baseUrl}/api/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return Response.json({ running: false, baseUrl });
    }

    const data = await res.json();
    return Response.json({
      running: true,
      version: data.version,
      baseUrl,
    });
  } catch {
    return Response.json({ running: false, baseUrl });
  }
}
