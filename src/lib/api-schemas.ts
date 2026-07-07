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
