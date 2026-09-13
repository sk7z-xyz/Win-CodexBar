import type { PaceSnapshot, ProviderUsageSnapshot, RateWindowSnapshot } from "../types/bridge";

/** Storage schema is versioned so future changes can safely invalidate it. */
export const PACE_HISTORY_STORAGE_KEY = "codexbar.quota-pace-history.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 512;
const RESET_TOLERANCE_MS = 60 * 1000;
const MINIMUM_ESTIMATE_AGE_MS = 5 * 60 * 1000;
const HORIZONS_MINUTES = [5, 15, 30, 60] as const;

export type PaceHorizonMinutes = (typeof HORIZONS_MINUTES)[number];

export interface PaceHistorySample {
  timestamp: number;
  usedPercent: number;
}

interface PaceHistoryEntry {
  resetAt: string | null;
  windowMinutes: number | null;
  samples: PaceHistorySample[];
}

type PaceHistoryStore = Record<string, PaceHistoryEntry>;

export interface BurnRates {
  "5m": number | null;
  "15m": number | null;
  "30m": number | null;
  "60m": number | null;
}

export interface HistoricalPaceEstimate {
  etaSeconds: number | null;
  willLastToReset: boolean;
  burnRates: BurnRates;
  /** True when this result was derived from persisted observations. */
  historical: true;
}

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStore(store: Storage | null = storage()): PaceHistoryStore {
  if (!store) return {};
  try {
    const parsed: unknown = JSON.parse(store.getItem(PACE_HISTORY_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as PaceHistoryStore;
  } catch {
    return {};
  }
}

function writeStore(value: PaceHistoryStore, store: Storage | null = storage()): void {
  if (!store) return;
  try {
    store.setItem(PACE_HISTORY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota/private browsing errors must never affect provider rendering.
  }
}

function validSample(value: unknown): value is PaceHistorySample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<PaceHistorySample>;
  return Number.isFinite(sample.timestamp) && Number.isFinite(sample.usedPercent);
}

function cleanEntry(value: unknown, now: number): PaceHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PaceHistoryEntry>;
  const samples = Array.isArray(raw.samples)
    ? raw.samples.filter(validSample).filter((sample) => now - sample.timestamp <= MAX_AGE_MS)
    : [];
  if (samples.length === 0) return null;
  samples.sort((a, b) => a.timestamp - b.timestamp);
  return {
    resetAt: typeof raw.resetAt === "string" ? raw.resetAt : null,
    windowMinutes: Number.isFinite(raw.windowMinutes) ? raw.windowMinutes! : null,
    samples: samples.slice(-MAX_SAMPLES),
  };
}

/** Stable scope that separates providers, accounts, and quota cadences. */
export function paceHistoryScope(snapshot: ProviderUsageSnapshot, quota: RateWindowSnapshot): string {
  const account = snapshot.accountEmail?.trim().toLowerCase() || "default";
  const source = snapshot.sourceLabel?.trim().toLowerCase() || "unknown";
  return [snapshot.providerId, account, source, quota.windowMinutes ?? "unknown"].join("|");
}

function resetChanged(previous: PaceHistoryEntry, quota: RateWindowSnapshot): boolean {
  if (!previous.resetAt || !quota.resetsAt || previous.resetAt === quota.resetsAt) return false;
  const oldMs = Date.parse(previous.resetAt);
  const newMs = Date.parse(quota.resetsAt);
  return !Number.isFinite(oldMs) || !Number.isFinite(newMs) || Math.abs(oldMs - newMs) > RESET_TOLERANCE_MS;
}

/** Record one observation and return the cleaned, persisted history for its scope. */
export function recordPaceObservation(
  snapshot: ProviderUsageSnapshot,
  quota: RateWindowSnapshot,
  now = Date.now(),
  store: Storage | null = storage(),
): PaceHistorySample[] {
  if (!Number.isFinite(now) || !Number.isFinite(quota.usedPercent)) return [];
  const all = readStore(store);
  const scope = paceHistoryScope(snapshot, quota);
  const old = cleanEntry(all[scope], now);
  const latest = old?.samples[old.samples.length - 1];

  // A reset is signalled by a new reset timestamp or a large backwards jump.
  // Clear before adding the first sample from the new quota cycle.
  const usageDropped = latest && quota.usedPercent < latest.usedPercent - 1;
  const samples = old && !resetChanged(old, quota) && !usageDropped ? [...old.samples] : [];
  const duplicate = samples[samples.length - 1];
  if (!duplicate || duplicate.timestamp !== now || Math.abs(duplicate.usedPercent - quota.usedPercent) > 0.001) {
    samples.push({ timestamp: now, usedPercent: quota.usedPercent });
  }
  const entry: PaceHistoryEntry = {
    resetAt: quota.resetsAt,
    windowMinutes: quota.windowMinutes,
    samples: samples.filter((sample) => now - sample.timestamp <= MAX_AGE_MS).slice(-MAX_SAMPLES),
  };
  all[scope] = entry;
  // Remove malformed/expired scopes while touching the store.
  for (const [key, value] of Object.entries(all)) {
    const cleaned = cleanEntry(value, now);
    if (cleaned) all[key] = cleaned;
    else delete all[key];
  }
  writeStore(all, store);
  return entry.samples;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Calculate a robust percent-per-minute rate. Pair rates are median-clipped
 * and then EWMA-smoothed, making a single unusually large refresh harmless.
 */
export function burnRateForHorizon(
  samples: PaceHistorySample[],
  horizonMinutes: PaceHorizonMinutes,
  now = Date.now(),
): number | null {
  const cutoff = now - horizonMinutes * 60 * 1000;
  const preceding = samples
    .filter((sample) => sample.timestamp < cutoff)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-1);
  const points = preceding
    .concat(samples.filter((sample) => sample.timestamp >= cutoff && sample.timestamp <= now))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (points.length < 2) return null;
  const rates: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const elapsed = points[index].timestamp - points[index - 1].timestamp;
    const delta = points[index].usedPercent - points[index - 1].usedPercent;
    if (elapsed > 0 && delta >= 0) rates.push((delta / elapsed) * 60 * 1000);
  }
  if (rates.length === 0) return null;
  const typical = median(rates);
  // Permit legitimate bursts, but cap pathological one-refresh spikes.
  const clipped = rates.map((rate) => (typical > 0 ? Math.min(rate, typical * 3) : rate));
  let smoothed = clipped[0];
  for (const rate of clipped.slice(1)) smoothed = smoothed * 0.65 + rate * 0.35;
  return Number.isFinite(smoothed) && smoothed > 0 ? smoothed : null;
}

function quotaWindow(snapshot: ProviderUsageSnapshot): RateWindowSnapshot | null {
  if (snapshot.primary.isInformational === true) return snapshot.secondary ?? null;
  return snapshot.primary;
}

function persistedSamples(
  snapshot: ProviderUsageSnapshot,
  quota: RateWindowSnapshot,
  now: number,
  store: Storage | null,
): PaceHistorySample[] {
  const entry = cleanEntry(readStore(store)[paceHistoryScope(snapshot, quota)], now);
  return entry?.samples ?? [];
}

/** Persist an observation and derive an ETA, or leave the backend pace intact. */
export function historicalPaceForSnapshot(
  snapshot: ProviderUsageSnapshot,
  now = Date.now(),
  store: Storage | null = storage(),
): HistoricalPaceEstimate | null {
  if (!snapshot.pace) return null;
  const quota = quotaWindow(snapshot);
  if (!quota || quota.isInformational || !quota.resetsAt) return null;
  // Cached snapshots can be hours old. Do not treat them as a new observation
  // (which would create a false jump on restart); use persisted samples until
  // the first live refresh arrives.
  const updatedAt = Date.parse(snapshot.updatedAt);
  const isFreshObservation =
    !Number.isFinite(updatedAt) || Math.abs(now - updatedAt) <= 2 * 60 * 1000;
  const samples = isFreshObservation
    ? recordPaceObservation(snapshot, quota, now, store)
    : persistedSamples(snapshot, quota, now, store);
  const burnRates: BurnRates = {
    "5m": burnRateForHorizon(samples, 5, now),
    "15m": burnRateForHorizon(samples, 15, now),
    "30m": burnRateForHorizon(samples, 30, now),
    "60m": burnRateForHorizon(samples, 60, now),
  };
  const available = HORIZONS_MINUTES.map((minutes) => burnRates[`${minutes}m` as keyof BurnRates]).filter(
    (rate): rate is number => rate != null,
  );
  const first = samples[0];
  const latest = samples[samples.length - 1];
  // Require a real five-minute history before changing the established ETA.
  if (!first || !latest || latest.timestamp - first.timestamp < MINIMUM_ESTIMATE_AGE_MS || available.length === 0) {
    return null;
  }
  const weights = [0.4, 0.3, 0.2, 0.1];
  const weightedRates = HORIZONS_MINUTES.map((minutes, index) => {
    const rate = burnRates[`${minutes}m` as keyof BurnRates];
    return rate == null ? null : { rate, weight: weights[index] };
  }).filter((item): item is { rate: number; weight: number } => item !== null);
  const weightTotal = weightedRates.reduce((sum, item) => sum + item.weight, 0);
  const rate = weightedRates.reduce((sum, item) => sum + item.rate * item.weight, 0) / weightTotal;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const remaining = Math.max(0, 100 - Math.max(0, Math.min(100, quota.usedPercent)));
  const etaSeconds = (remaining / rate) * 60;
  const resetMs = Date.parse(quota.resetsAt);
  const untilReset = Number.isFinite(resetMs) ? Math.max(0, (resetMs - now) / 1000) : Number.POSITIVE_INFINITY;
  return {
    etaSeconds: etaSeconds < untilReset ? etaSeconds : null,
    willLastToReset: etaSeconds >= untilReset,
    burnRates,
    historical: true,
  };
}

/** Decorate a backend snapshot while preserving its existing fallback pace. */
export function enrichSnapshotWithHistoricalPace(snapshot: ProviderUsageSnapshot, now = Date.now()): ProviderUsageSnapshot {
  const historical = historicalPaceForSnapshot(snapshot, now);
  if (!historical || !snapshot.pace) return snapshot;
  return {
    ...snapshot,
    pace: {
      ...snapshot.pace,
      etaSeconds: historical.etaSeconds,
      willLastToReset: historical.willLastToReset,
      burnRates: historical.burnRates,
      historical: true,
    },
  };
}
