import { getRuntimeConfig } from "@/lib/runtime-config";

export async function POST(request: Request) {
  const rc = getRuntimeConfig();
  const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";

  try {
    const body = await request.json();
    const { name } = body;
    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const res = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
    });

    if (!res.ok) {
      return Response.json({ error: "Failed to pull model" }, { status: 502 });
    }

    // Stream NDJSON progress back to client
    const upstream = res.body;
    if (!upstream) {
      return Response.json({ error: "No response body" }, { status: 502 });
    }

    const readable = new ReadableStream({
      async start(controller) {
        const reader = upstream.getReader();
        const encoder = new TextEncoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(encoder.encode(new TextDecoder().decode(value)));
          }
        } catch {
          // Stream ended
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch {
    return Response.json({ error: "Cannot reach Ollama" }, { status: 502 });
  }
}
