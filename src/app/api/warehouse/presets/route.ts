import { loadConnections, removeConnection, renameConnection } from "@/lib/warehouse/persist-env";

export async function GET() {
  const connections = await loadConnections();
  return Response.json({ connections });
}

export async function PATCH(request: Request) {
  try {
    const { id, name } = await request.json();
    if (!id || typeof name !== "string") {
      return Response.json({ error: "id and name are required" }, { status: 400 });
    }
    await renameConnection(id, name);
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to rename connection";
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { id } = await request.json();
    if (!id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    await removeConnection(id);
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete connection";
    return Response.json({ error: msg }, { status: 500 });
  }
}
