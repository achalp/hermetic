// This route is no longer used — warehouse queries go through /api/warehouse/query
// Kept as a no-op to avoid 404s if old clients call it
export async function POST() {
  return Response.json(
    {
      error:
        "This endpoint has been replaced by /api/warehouse/query. Connect to a warehouse and query directly.",
    },
    { status: 410 }
  );
}
