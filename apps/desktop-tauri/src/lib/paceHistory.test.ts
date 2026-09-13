import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderUsageSnapshot, RateWindowSnapshot } from "../types/bridge";
import {
  burnRateForHorizon,
  historicalPaceForSnapshot,
  PACE_HISTORY_STORAGE_KEY,
  recordPaceObservation,
} from "./paceHistory";

const NOW = Date.parse("2026-06-12T04:00:00.000Z");

function quota(usedPercent: number, resetAt = "2026-06-12T10:00:00.000Z"): RateWindowSnapshot {
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowMinutes: 360,
    resetsAt: resetAt,
    resetDescription: null,
    isExhausted: false,
    reservePercent: null,
    reserveDescription: null,
  };
}

function snapshot(usedPercent: number, resetAt?: string): ProviderUsageSnapshot {
  const primary = quota(usedPercent, resetAt);
  return {
    providerId: "codex",
    displayName: "Codex",
    primary,
    selectedMetric: primary,
    secondary: null,
    modelSpecific: null,
    tertiary: null,
    extraRateWindows: [],
    cost: null,
    planName: null,
    accountEmail: "user@example.com",
    sourceLabel: "Codex API",
    updatedAt: new Date(NOW).toISOString(),
    error: null,
    errorState: "ready",
    pace: {
      stage: "on_track",
      deltaPercent: 0,
      willLastToReset: false,
      etaSeconds: 100,
      expectedUsedPercent: 10,
      actualUsedPercent: usedPercent,
    },
    accountOrganization: null,
    trayStatusLabel: null,
  };
}

describe("pace history", () => {
  beforeEach(() => localStorage.removeItem(PACE_HISTORY_STORAGE_KEY));

  it("persists observations and derives all recent burn-rate windows", () => {
    const store = localStorage;
    for (const [minutes, used] of [[0, 10], [5, 15], [15, 25], [30, 40], [60, 70]] as const) {
      recordPaceObservation(snapshot(used), quota(used), NOW + minutes * 60_000, store);
    }
    const parsed = JSON.parse(store.getItem(PACE_HISTORY_STORAGE_KEY)!) as Record<string, { samples: { timestamp: number; usedPercent: number }[] }>;
    const entry = Object.values(parsed)[0];
    expect(entry.samples).toHaveLength(5);
    expect(burnRateForHorizon(entry.samples, 5, NOW + 60 * 60_000)).toBeGreaterThan(0);
  });

  it("discards the old cycle when reset timestamp changes or usage drops", () => {
    const store = localStorage;
    recordPaceObservation(snapshot(50), quota(50), NOW, store);
    recordPaceObservation(snapshot(2, "2026-06-12T16:00:00.000Z"), quota(2, "2026-06-12T16:00:00.000Z"), NOW + 60_000, store);
    const parsed = JSON.parse(store.getItem(PACE_HISTORY_STORAGE_KEY)!) as Record<string, { samples: { timestamp: number; usedPercent: number }[] }>;
    const entry = Object.values(parsed)[0];
    expect(entry.samples).toHaveLength(1);
    expect(entry.samples[0].usedPercent).toBe(2);
  });

  it("falls back until at least five minutes of observations are available", () => {
    const store = localStorage;
    recordPaceObservation(snapshot(10), quota(10), NOW, store);
    recordPaceObservation(snapshot(20), quota(20), NOW + 60_000, store);
    expect(historicalPaceForSnapshot(snapshot(20), NOW + 60_000, store)).toBeNull();
  });

  it("returns a weighted historical ETA once the history is mature", () => {
    const store = localStorage;
    for (const [minutes, used] of [[0, 10], [5, 20], [15, 30], [30, 40], [60, 50]] as const) {
      recordPaceObservation(snapshot(used), quota(used), NOW + minutes * 60_000, store);
    }
    const current = snapshot(50);
    current.updatedAt = new Date(NOW + 60 * 60_000).toISOString();
    const estimate = historicalPaceForSnapshot(current, NOW + 60 * 60_000, store);
    expect(estimate?.historical).toBe(true);
    expect(estimate?.etaSeconds).toBeGreaterThan(0);
    expect(estimate?.burnRates["5m"]).toBeGreaterThan(0);
  });

  it("uses a smoothed rate so a single large spike is bounded", () => {
    const samples = [
      { timestamp: NOW, usedPercent: 10 },
      { timestamp: NOW + 60_000, usedPercent: 11 },
      { timestamp: NOW + 120_000, usedPercent: 60 },
      { timestamp: NOW + 300_000, usedPercent: 61 },
    ];
    const rate = burnRateForHorizon(samples, 5, NOW + 300_000);
    expect(rate).toBeLessThan(15);
    expect(rate).toBeGreaterThan(0);
  });
});
