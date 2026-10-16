// File-era cron shapes are read only by Doctor, before canonical SQLite persistence.
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { coerceFiniteScheduleNumber } from "../../../cron/schedule-number.js";
import { normalizeCronStaggerMs } from "../../../cron/stagger.js";
import { parseJsonWithJson5Fallback } from "../../../utils/parse-json-compat.js";

function parseCronStateFile(raw: string): {
  version: 1;
  jobs: Record<string, unknown>;
} | null {
  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.jobs)) {
      return null;
    }
    return {
      version: 1,
      jobs: parsed.jobs,
    };
  } catch {
    return null;
  }
}

function legacySchedulePayloadFromRecord(
  schedule: Record<string, unknown>,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | undefined {
  const rawKind = normalizeOptionalString(schedule.kind)?.toLowerCase();
  const expr = normalizeOptionalString(schedule.expr) ?? normalizeOptionalString(schedule.cron);
  const at = normalizeOptionalString(schedule.at);
  const atMs = coerceFiniteScheduleNumber(schedule.atMs);
  const everyMs = coerceFiniteScheduleNumber(schedule.everyMs);
  const anchorMs = coerceFiniteScheduleNumber(schedule.anchorMs);
  const tz = normalizeOptionalString(schedule.tz);
  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at || atMs !== undefined
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "at") {
    return at
      ? { kind: "at", at }
      : atMs !== undefined
        ? { kind: "at", at: String(atMs) }
        : undefined;
  }
  if (kind === "every" && everyMs !== undefined) {
    return { kind: "every", everyMs, anchorMs };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz, staggerMs };
  }
  return undefined;
}

function tryLegacyCronScheduleIdentity(job: Record<string, unknown>): string | undefined {
  const schedule = legacySchedulePayloadFromRecord(isRecord(job.schedule) ? job.schedule : job);
  if (!schedule) {
    return undefined;
  }
  return JSON.stringify({
    version: 1,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
  });
}

function getRawCronJobs(parsed: unknown): unknown[] {
  return Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : [];
}

function hasInlineState(jobs: Array<Record<string, unknown> | null | undefined>): boolean {
  return jobs.some(
    (job) => job != null && isRecord(job.state) && Object.keys(job.state).length > 0,
  );
}

function ensureJobStateObject(job: Record<string, unknown>): void {
  if (!isRecord(job.state)) {
    job.state = {};
  }
}

function backfillMissingRuntimeFields(job: Record<string, unknown>): void {
  ensureJobStateObject(job);
  if (typeof job.updatedAtMs !== "number") {
    job.updatedAtMs = typeof job.createdAtMs === "number" ? job.createdAtMs : Date.now();
  }
}

function resolveUpdatedAtMs(job: Record<string, unknown>, updatedAtMs: unknown): number {
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }
  if (typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)) {
    return job.updatedAtMs;
  }
  return typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
    ? job.createdAtMs
    : Date.now();
}

function mergeStateFileEntry(job: Record<string, unknown>, entry: unknown): void {
  if (!isRecord(entry)) {
    backfillMissingRuntimeFields(job);
    return;
  }
  job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
  const state = isRecord(entry.state) ? entry.state : {};
  job.state = state;
  if (
    typeof entry.scheduleIdentity === "string" &&
    entry.scheduleIdentity !== tryLegacyCronScheduleIdentity(job)
  ) {
    state.nextRunAtMs = undefined;
  }
}

function resolveCronStateId(job: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
}

/** Decode the shipped JSON store and its optional split runtime state. */
export function parseLegacyCronJobs(
  storeBytes: Buffer,
  stateBytes?: Buffer,
): {
  jobs: Array<Record<string, unknown>>;
  warnings: string[];
} {
  const parsed = parseJsonWithJson5Fallback(storeBytes.toString("utf8"));
  if (!Array.isArray(parsed) && !(isRecord(parsed) && Array.isArray(parsed.jobs))) {
    throw new Error("Unrecognized legacy cron job store; expected an array or a jobs array");
  }
  const jobs: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  for (const [index, row] of getRawCronJobs(parsed).entries()) {
    if (!isRecord(row)) {
      warnings.push(`Cron row ${index} is not an object and remains available in the archive.`);
      continue;
    }
    // Stable identities make a retry after a committed import safe even before archival.
    row.id =
      normalizeOptionalStringifiedId(row.id) ??
      normalizeOptionalStringifiedId(row.jobId) ??
      `cron-migrated-${index}-${createHash("sha256").update(JSON.stringify(row)).digest("hex")}`;
    if (isRecord(row.createdActor) && row.createdActor.type === "human") {
      row.createdActor = { ...row.createdActor, source: "unknown" };
    }
    jobs.push(row);
  }
  const stateFile = stateBytes ? parseCronStateFile(stateBytes.toString("utf8")) : null;
  if (stateBytes && !stateFile) {
    warnings.push("Unrecognized legacy cron runtime state remains available in the archive.");
  }
  const inlineState = !stateFile && hasInlineState(jobs);
  for (const job of jobs) {
    if (stateFile) {
      const id = resolveCronStateId(job);
      mergeStateFileEntry(job, id ? stateFile.jobs[id] : undefined);
    } else if (inlineState) {
      ensureJobStateObject(job);
    } else {
      backfillMissingRuntimeFields(job);
    }
  }
  return { jobs, warnings };
}
