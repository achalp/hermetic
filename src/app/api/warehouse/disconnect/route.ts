import { removeWarehouse } from "@/lib/warehouse/storage";

export async function POST(request: Request) {
  try {
    const { warehouse_id } = await request.json();

    if (!warehouse_id) {
      return Response.json({ error: "warehouse_id is required" }, { status: 400 });
    }

    removeWarehouse(warehouse_id);
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
