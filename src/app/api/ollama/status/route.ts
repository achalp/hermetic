import { getRuntimeConfig } from "@/lib/runtime-config";

export async function GET() {
  const rc = getRuntimeConfig();
  const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";

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
