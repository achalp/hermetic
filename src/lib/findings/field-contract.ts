/**
 * The field contract: the CLOSED vocabulary of the runtime claim helpers,
 * classified once, consulted everywhere (whack-a-mole postmortem,
 * 2026-08-13). Eight audited runs discovered projection rules one incident
 * at a time — booleans (run f47eb42d), dict leaves (run 9c415dc8), zero
 * counts (run d82a39ce). Every one of those fields was knowable at
 * declaration time: findings.py is a finite vocabulary. This table names
 * each field's class; the exhaustiveness test in test_runtime.py calls
 * every helper and fails when a field is emitted that the table does not
 * classify — a NEW runtime field cannot ship unclassified.
 *
 * The projection consults the table FIRST and falls back to the
 * incident-derived heuristics only for open-vocabulary fields (bespoke
 * model-declared findings, check evidence): the open world keeps its
 * heuristics, the closed world stops being reactive.
 */
import contractJson from "./field-contract.json";

export type FieldClass =
  | "scalar"
  | "unit_scalar"
  | "period"
  | "verdict"
  | "mapping"
  | "interval"
  | "count"
  | "internal"
  | "evidence";

interface DtypeEntry {
  alias?: string;
  open?: boolean;
  fields?: Record<string, string>;
}

const DTYPES = (contractJson as { dtypes: Record<string, DtypeEntry> }).dtypes;

function resolveDtype(dtype: string): DtypeEntry | undefined {
  const entry = DTYPES[dtype];
  if (entry?.alias) return DTYPES[entry.alias];
  return entry;
}

/** The declared class of a field on a dtype, or undefined when the field
 *  is outside the contract (bespoke finding, open-dtype extra field) and
 *  the caller's heuristics decide. */
export function fieldClass(dtype: string, field: string): FieldClass | undefined {
  return resolveDtype(dtype)?.fields?.[field] as FieldClass | undefined;
}

/** Whether a dtype admits fields beyond its contract (model-declared
 *  evidence and bespoke keys). Unknown dtypes are open by definition. */
export function dtypeIsOpen(dtype: string): boolean {
  const entry = resolveDtype(dtype);
  return entry === undefined || entry.open === true;
}

/** Every dtype named by the contract (aliases resolved), for tests. */
export function contractDtypes(): string[] {
  return Object.keys(DTYPES);
}
