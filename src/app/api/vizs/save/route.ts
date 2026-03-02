import { NextResponse } from "next/server";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getStoredCSV, getCSVContent } from "@/lib/csv/storage";
import { saveVisualization } from "@/lib/saved/storage";

export async function POST(request: Request) {
  try {
    const { csvId, spec, question } = await request.json();

    if (!csvId || !spec || !question) {
      return NextResponse.json(
        { error: "csvId, spec, and question are required" },
        { status: 400 }
      );
    }

    // Look up cached code
    const cached = getCachedCode(csvId);
    if (!cached) {
      return NextResponse.json(
        { error: "Generated code not found in cache. It may have expired — please re-run the query." },
        { status: 404 }
      );
    }

    // Look up CSV
    const stored = getStoredCSV(csvId);
    if (!stored) {
      return NextResponse.json(
        { error: "CSV not found or expired. Please re-upload." },
        { status: 404 }
      );
    }

    const csvContent = await getCSVContent(csvId);
    if (!csvContent) {
      return NextResponse.json(
        { error: "CSV content not found" },
        { status: 404 }
      );
    }

    const meta = await saveVisualization({
      question,
      csvFilename: stored.schema.filename,
      csvContent,
      generatedCode: cached.code,
      spec,
    });

    return NextResponse.json({ meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
