import { NextResponse } from "next/server";
import { generateText } from "ai";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { parseBody, ManifestSelectBody } from "@/lib/api-schemas";
import { getManifestStore } from "@/lib/manifest/store";
import { buildSelectionPrompt, parseSelection } from "@/lib/manifest/select";
import { getModel } from "@/lib/llm/client";
import { getActiveModels } from "@/lib/runtime-config";
import { trackRouteCost } from "@/lib/cost/epilogue";
import { apiError } from "@/app/lib/api-error";
import { logger, errMessage } from "@/lib/logger";

/**
 * Entity-selection pre-step (spec §7; review: K=4, hard cap 6, CODE-GEN model
 * tier — the pick decides what the expensive step sees, so it gets the better
 * model). Reads only the manifest's own index (names, descriptions, row hints)
 * — schemas are NOT needed to choose; they are introspected for the chosen
 * entities afterward, by the client's existing per-entity flow.
 *
 * Deliberately NOT cached across questions (the scanWindow lesson): the pick is
 * question-dependent, and a cached pick serves a wrong scope to the next
 * question. The deterministic keyword fallback means a model failure degrades
 * to a plausible pick, never to a dead question.
 */
export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const parsed = parseBody(ManifestSelectBody, await request.json());
    if (!parsed.ok) return parsed.response;
    const { manifestId, question } = parsed.data;

    const record = getManifestStore().get(manifestId);
    if (!record) return NextResponse.json({ error: "unknown manifest" }, { status: 404 });

    // trackRouteCost wraps the whole handler body so the pre-step's spend lands
    // in the cost ledger like suggest/title calls do.
    const { entities, usedFallback } = await trackRouteCost(
      { mode: "manifest-select", question },
      async () => {
        let raw = "";
        try {
          const result = await generateText({
            model: getModel(getActiveModels().codeGen),
            prompt: buildSelectionPrompt(record, question),
            temperature: 0,
            maxOutputTokens: 200,
          });
          raw = result.text;
        } catch (err) {
          // Model failure → the deterministic fallback below still yields a pick.
          logger.warn("Manifest select: model call failed, using fallback", {
            error: errMessage(err),
          });
        }
        return parseSelection(raw, record, question);
      }
    );
    logger.info("Manifest select", {
      manifestId,
      picked: entities,
      usedFallback,
    });
    return NextResponse.json({ entities, usedFallback });
  } catch (err) {
    return apiError("/api/manifest/select", err, "Failed to select entities");
  }
}
