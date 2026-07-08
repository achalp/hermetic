import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { listCostRows } from "@/lib/cost/storage";

export async function GET() {
  try {
    const rows = await listCostRows();
    return NextResponse.json({ rows });
  } catch (err) {
    return apiError("/api/cost", err, "Failed to list cost data");
  }
}
