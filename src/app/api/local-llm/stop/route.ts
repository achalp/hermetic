import { apiError } from "@/app/lib/api-error";
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
    return apiError("/api/local-llm/stop", err, "Failed to stop server");
  }
}
