import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { listSavedVisualizations } from "@/lib/saved/storage";

export async function GET() {
  try {
    const vizs = await listSavedVisualizations();
    return NextResponse.json({ vizs });
  } catch (err) {
    return apiError("/api/vizs", err, "Failed to list visualizations");
  }
}
