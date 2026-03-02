import { NextResponse } from "next/server";
import { listSavedVisualizations } from "@/lib/saved/storage";

export async function GET() {
  try {
    const vizs = await listSavedVisualizations();
    return NextResponse.json({ vizs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list visualizations";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
