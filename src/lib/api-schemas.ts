/**
 * zod request-body schemas for the highest-risk API routes.
 *
 * Routes used to cast bodies (`body as {...}`) with ad-hoc null checks —
 * compile-time-only "validation" that let malformed shapes (numbers where
 * strings belong, junk credential values, whole-config casts checked only on
 * `type`) flow into fs/connector/SQL layers. These schemas make the accepted
 * shape explicit; `parseBody()` returns a 400 with the precise issues.
 *
 * The schemas deliberately mirror the existing TypeScript config interfaces
 * in lib/types.ts — valid input behaves exactly as before.
 */
import { z } from "zod";
import { logger } from "@/lib/logger";

/**
 * Read a request's JSON body, mapping failure to a 400 — NOT a 500. When a
 * client aborts a duplicate/in-flight request the body stream truncates and
 * request.json() throws "Unexpected end of JSON input"; the routes' catch-alls
 * used to log that at ERROR and return 500, misreporting a client abort as a
 * server fault (recurring noise in the streaming investigations). Logged at
 * debug: it's client behavior, not a server problem.
 */
export async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await request.json() };
  } catch (err) {
    logger.debug("Request body unreadable (likely client abort)", {
      aborted: request.signal?.aborted ?? false,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Invalid or incomplete JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
}

/** safeParse a body against a schema; on failure build the 400 response. */
export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown
): { ok: true; data: T } | { ok: false; response: Response } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: `Invalid request: ${issues}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

// ── local-files (user-supplied filesystem paths) ─────────────────────────

export const LocalFileSelectSchema = z.object({
  path: z.string().min(1).max(4096),
  type: z.enum(["file", "folder"]),
});

// ── remote parquet (server-side fetch of a user URL) ─────────────────────

export const RemoteCredsSchema = z
  .object({
    s3Region: z.string().max(512).optional(),
    s3AccessKeyId: z.string().max(512).optional(),
    s3SecretAccessKey: z.string().max(512).optional(),
    s3Endpoint: z.string().max(512).optional(),
  })
  .optional();

export const RemoteParquetSchemaBody = z.object({
  url: z.string().min(1).max(2048),
  creds: RemoteCredsSchema,
  /** "Ignore cache / re-read schema" — skip the cache and overwrite it. */
  force: z.boolean().optional(),
});

// ── warehouse connect (credentials → live connector) ─────────────────────

const port = z.number().int().min(1).max(65535);

export const WarehouseConnectionConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("postgresql"),
    host: z.string().min(1),
    port,
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    ssl: z.boolean().optional(),
    schema: z.string().optional(),
  }),
  z.object({
    type: z.literal("bigquery"),
    projectId: z.string().min(1),
    dataset: z.string().min(1),
    credentialsJson: z.string().min(1),
  }),
  z.object({
    type: z.literal("clickhouse"),
    host: z.string().min(1),
    port,
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    ssl: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("trino"),
    host: z.string().min(1),
    port,
    user: z.string().min(1),
    catalog: z.string().min(1),
    schema: z.string().min(1),
    password: z.string().optional(),
    ssl: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("hive"),
    host: z.string().min(1),
    port,
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().optional(),
    auth: z.enum(["NONE", "NOSASL", "LDAP", "KERBEROS"]).optional(),
  }),
  z.object({
    type: z.literal("snowflake"),
    account: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    database: z.string().min(1),
    schema: z.string().optional(),
    warehouse: z.string().optional(),
    role: z.string().optional(),
  }),
  z.object({
    type: z.literal("databricks"),
    serverHostname: z.string().min(1),
    httpPath: z.string().min(1),
    token: z.string().min(1),
    catalog: z.string().min(1),
    schema: z.string().optional(),
  }),
]);

// ── /api/query and /api/query/investigate ─────────────────────────────
// Declared as z.ZodType<AnalysisRequest> so any drift between this schema and
// the shared contract type fails compilation (modularization M1-1c).

const filterValueSchema: z.ZodType<import("@/lib/contracts/spec-types").FilterValue> = z.union([
  z.string(),
  z.number(),
  z.array(z.union([z.string(), z.number()])),
]);

const drillDownContextSchema = z.object({
  parent_question: z.string(),
  filter_column: z.string(),
  filter_value: filterValueSchema,
  segment_label: z.string(),
  chart_title: z.string().nullable(),
  additional_filters: z.array(z.object({ column: z.string(), value: filterValueSchema })).nullish(),
});

const investigateScopeSchema = z.object({
  parent_question: z.string().optional(),
  prior_approach: z.string().optional(),
  prior_steps: z.array(z.string()).optional(),
  filters: z.array(z.object({ column: z.string(), value: filterValueSchema })).optional(),
  segment_label: z.string().optional(),
});

export const analysisRequestSchema: z.ZodType<
  import("@/lib/contracts/analysis-request").AnalysisRequest
> = z.object({
  prompt: z.string().optional(),
  context: z
    .object({
      csv_id: z.string().optional(),
      warehouse_id: z.string().optional(),
      question: z.string().optional(),
      schema_mode: z.enum(["metadata", "sample"]).optional(),
      code_gen_model: z.string().optional(),
      ui_compose_model: z.string().optional(),
      sandbox_runtime: z.string().optional(),
      purpose: z.string().optional(),
      code: z.string().optional(),
      sql: z.string().optional(),
      drill_down_context: drillDownContextSchema.optional(),
      scope: investigateScopeSchema.optional(),
      compose_cells: z.boolean().optional(),
    })
    .optional(),
});
