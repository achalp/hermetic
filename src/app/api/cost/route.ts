import { NextResponse } from "next/server";
import { listCostRows } from "@/lib/cost/storage";

export async function GET() {
  try {
    const rows = await listCostRows();
    return NextResponse.json({ rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list cost data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
