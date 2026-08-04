import { getRuntimeConfig } from "@/lib/runtime-config";
import { DEFAULT_LOCAL_LLM_ENDPOINTS } from "@/lib/constants";

export async function GET() {
  const rc = getRuntimeConfig();
  const baseUrl = rc.ollama?.baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS.ollama;

  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) {
      return Response.json({ error: "Failed to list models" }, { status: 502 });
    }
    const data = await res.json();
    const models = (data.models ?? []).map(
      (m: { name: string; size: number; modified_at: string }) => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
      })
    );
    return Response.json({ models });
  } catch {
    return Response.json({ error: "Cannot reach Ollama" }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const rc = getRuntimeConfig();
  const baseUrl = rc.ollama?.baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS.ollama;

  try {
    const body = await request.json();
    const { name } = body;
    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const res = await fetch(`${baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      return Response.json({ error: "Failed to delete model" }, { status: 502 });
    }

    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "Cannot reach Ollama" }, { status: 502 });
  }
}
