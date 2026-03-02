import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ csvId: string }> }
) {
  const { csvId } = await params;
  const artifacts = getCachedArtifacts(csvId);

  if (!artifacts) {
    return new Response(
      JSON.stringify({ error: "Artifacts not found or expired" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify(artifacts), {
    headers: { "Content-Type": "application/json" },
  });
}
