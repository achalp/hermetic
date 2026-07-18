import { removeWarehouse } from "@/lib/warehouse/storage";
import { apiError } from "@/lib/api-error";

export async function POST(request: Request) {
  try {
    const { warehouse_id } = await request.json();

    if (!warehouse_id) {
      return Response.json({ error: "warehouse_id is required" }, { status: 400 });
    }

    removeWarehouse(warehouse_id);
    return Response.json({ ok: true });
  } catch (err) {
    return apiError("/api/warehouse/disconnect", err, "Unknown error");
  }
}
