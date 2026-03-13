import { stopServer } from "@/lib/llm/process-manager";

export async function POST(request: Request) {
  const body = await request.json();
  const { backend } = body;

  if (!backend) {
    return Response.json({ error: "backend is required" }, { status: 400 });
  }

  try {
    await stopServer(backend);
    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to stop server";
    return Response.json({ error: message }, { status: 500 });
  }
}
