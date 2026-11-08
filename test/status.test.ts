import { describe, it, expect } from "vitest";
import type { RelayEventV2 } from "../src/audit.js";
import { renderStatus, statusData } from "../src/status.js";

const NOW = Date.parse("2026-11-08T22:00:00Z");
let n = 0;
const ev = (minAgo: number, pod: string | null, host: string, outcome: RelayEventV2["outcome"] = "ok", httpStatus?: number, bytes = 1000): RelayEventV2 => {
  const at = new Date(NOW - minAgo * 60_000).toISOString();
  return {
    v: 2, id: `e${n++}`, startedAt: at, finishedAt: at, durationMs: 100, mode: host === "polymarket.com" ? "tunnel" : "fetch", outcome, target: `https://${host}/`, host,
    httpStatus, session: false, bytesDown: bytes,
    source: pod === null ? { system: "health-check" } : { podId: pod.replace(/ /g, "-"), podName: pod },
  };
};

const events = [
  ev(1, "afisha crawler", "espn.com"),
  ev(2, "afisha crawler", "espn.com"),
  ev(3, "crypto sail club", "polymarket.com"),
  ev(50, "afisha crawler", "espn.com", "network-error"), // older error listed first…
  ev(10, "afisha crawler", "espn.com", "rate-limited", 429), // …the newer one must win
  ev(18, "crypto sail club", "reddit.com", "site-refused", 403),
  ev(40, "crypto sail club", "reddit.com"),
  ev(5, null, "example.com"), // health check: not a pod, not counted
  ev(2 * 60, "podway GTM", "linkedin.com"), // outside 1h, inside 24h
  ev(3 * 24 * 60, "podway GTM", "old.example"), // outside 24h
];

describe("relay status tables (owner's DiskStation has no reachable web dashboard)", () => {
  it("counts per pod and per site in the window, with OK% and the last error", () => {
    const d = statusData(events, { state: "running", startedAt: new Date(NOW - 3 * 3600_000).toISOString(), link: "connected" }, "24h", NOW);
    expect(d.requests).toBe(8);
    expect(d.okPct).toBe(63);
    expect(d.bytes).toBe(1000); // tunnel bytes only (polymarket.com is the one tunnel event in 24h)
    expect(statusData(events.filter((e) => e.mode === "fetch"), { state: "running" }, "24h", NOW).bytes).toBeNull();
    expect(d.pods.map((p) => [p.name, p.requests, p.okPct])).toEqual([["afisha crawler", 4, 50], ["crypto sail club", 3, 67], ["podway GTM", 1, 100]]);
    const reddit = d.sites.find((s) => s.host === "reddit.com")!;
    expect([reddit.requests, reddit.okPct, reddit.lastError]).toEqual([2, 50, "403 refused"]);
    expect(d.sites.find((s) => s.host === "espn.com")!.lastError).toBe("429 rate limited");
    expect(d.sites.find((s) => s.host === "polymarket.com")!.lastError).toBeNull();
    const text = renderStatus(d, { limit: 10, now: NOW });
    expect(text).toMatch(/STATE\s+UPTIME\s+LINK\s+REQ 24h\s+OK%\s+DATA/);
    expect(text).toMatch(/running\s+3h 0m\s+connected\s+8\s+63%\s+1000 B/);
    expect(text).toMatch(/crypto sail club\s+3\s+67%\s+3 min ago/);
    expect(text).toMatch(/reddit\.com\s+2\s+50%\s+403 refused, 18 min ago/);
    expect(text).not.toContain("example.com");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("--since narrows the window", () => {
    const d = statusData(events, { state: "running", link: "connected" }, "1h", NOW);
    expect(d.requests).toBe(7);
    expect(d.pods.map((p) => p.name)).not.toContain("podway GTM");
    expect(statusData(events, { state: "running" }, "7d", NOW).requests).toBe(9);
  });

  it("stopped: STATE says stopped and the saved history still shows", () => {
    const d = statusData(events, { state: "stopped", startedAt: "2026-11-08T00:00:00Z", link: "connected" }, "24h", NOW);
    expect([d.state, d.uptimeMs, d.link]).toEqual(["stopped", null, null]);
    const text = renderStatus(d, { limit: 10, now: NOW });
    expect(text).toMatch(/stopped\s+—\s+—\s+8/);
    expect(text).toContain("afisha crawler");
  });

  it("limits rows and says how many are hidden", () => {
    const d = statusData(events, { state: "running" }, "24h", NOW);
    expect(renderStatus(d, { limit: 1, now: NOW })).toMatch(/\d+ more rows — relay status --all/);
  });

  it("--json carries the same numbers, machine-readable", () => {
    const d = statusData(events, { state: "running", link: "connected" }, "24h", NOW);
    const j = JSON.parse(JSON.stringify(d));
    expect(Object.keys(j).sort()).toEqual(["bytes", "link", "okPct", "pods", "requests", "sites", "state", "uptimeMs", "window"]);
    expect(Object.keys(j.pods[0]).sort()).toEqual(["lastAt", "name", "okPct", "requests"]);
    expect(Object.keys(j.sites[0]).sort()).toEqual(["host", "lastError", "lastErrorAt", "okPct", "requests"]);
  });

  it("an empty history says so instead of empty tables", () => {
    const text = renderStatus(statusData([], { state: "stopped" }, "24h", NOW), { limit: 10, now: NOW });
    expect(text).toContain("no pod requests in the last 24h");
    expect(text).not.toContain("POD");
  });
});
