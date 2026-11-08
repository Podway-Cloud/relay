/**
 * `relay status` stats as docker-ps style tables (owner, 2026-11-08: the web dashboard is not reachable on
 * a headless NAS, so the terminal has to show what the relay did). Pure: events in, text/JSON out. It reads
 * only the saved event history — no transport, browser or dashboard module — so status stays fast.
 */
import type { RelayEventV2, RelayOutcome } from "./audit.js";
import { c } from "./colors.js";

export const WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;
export type StatusWindow = keyof typeof WINDOWS;

export interface StatusHead {
  state: "running" | "stopped";
  startedAt?: string; // daemon start, for UPTIME
  link?: string; // connected | reconnecting | stopped | unknown — plain word, no colour
}

interface Row { name: string; req: number; ok: number; last: number; lastError?: RelayEventV2 }

export interface StatusData {
  window: StatusWindow;
  state: StatusHead["state"];
  uptimeMs: number | null;
  link: string | null;
  requests: number;
  okPct: number | null;
  bytes: number | null; // tunnel traffic only (fetch events carry no size); null = no tunnel in the window
  pods: { name: string; requests: number; okPct: number; lastAt: string }[];
  sites: { host: string; requests: number; okPct: number; lastError: string | null; lastErrorAt: string | null }[];
}

const ERROR_WORD: Record<Exclude<RelayOutcome, "ok">, string> = {
  "site-refused": "refused",
  "owner-blocked": "blocked by you",
  "safety-blocked": "blocked (safety)",
  "rate-limited": "rate limited",
  "network-error": "network error",
};

function errorText(e: RelayEventV2): string {
  return [e.httpStatus, ERROR_WORD[e.outcome as Exclude<RelayOutcome, "ok">] ?? e.outcome].filter(Boolean).join(" ");
}

function podName(e: RelayEventV2): string | null {
  if (!e.source) return "(unknown)";
  if ("system" in e.source) return null; // the relay's own health checks are not a pod
  return e.source.podName || e.source.podId;
}

function group(events: RelayEventV2[], key: (e: RelayEventV2) => string | null): Row[] {
  const by = new Map<string, Row>();
  for (const e of events) {
    const k = key(e);
    if (!k) continue;
    const t = Date.parse(e.startedAt);
    const r = by.get(k) ?? { name: k, req: 0, ok: 0, last: 0 };
    r.req++;
    if (e.outcome === "ok") r.ok++;
    else if (!r.lastError || t > Date.parse(r.lastError.startedAt)) r.lastError = e;
    r.last = Math.max(r.last, t);
    by.set(k, r);
  }
  return [...by.values()].sort((a, b) => b.req - a.req || b.last - a.last);
}

const pct = (ok: number, n: number) => (n ? Math.round((ok / n) * 100) : 0);

export function statusData(events: RelayEventV2[], head: StatusHead, window: StatusWindow, now = Date.now()): StatusData {
  const inWindow = events.filter((e) => Date.parse(e.startedAt) >= now - WINDOWS[window]);
  const counted = inWindow.filter((e) => podName(e) !== null);
  const ok = counted.filter((e) => e.outcome === "ok").length;
  return {
    window,
    state: head.state,
    uptimeMs: head.state === "running" && head.startedAt ? Math.max(0, now - Date.parse(head.startedAt)) : null,
    link: head.state === "running" ? (head.link ?? "unknown") : null,
    requests: counted.length,
    okPct: counted.length ? pct(ok, counted.length) : null,
    bytes: counted.some((e) => e.mode === "tunnel") ? counted.filter((e) => e.mode === "tunnel").reduce((s, e) => s + (e.bytesUp ?? 0) + (e.bytesDown ?? 0), 0) : null,
    pods: group(counted, podName).map((r) => ({ name: r.name, requests: r.req, okPct: pct(r.ok, r.req), lastAt: new Date(r.last).toISOString() })),
    sites: group(counted, (e) => e.host).map((r) => ({
      host: r.name, requests: r.req, okPct: pct(r.ok, r.req),
      lastError: r.lastError ? errorText(r.lastError) : null,
      lastErrorAt: r.lastError ? r.lastError.startedAt : null,
    })),
  };
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function duration(ms: number): string {
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

function size(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

const cut = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s);

/** Columns padded to fixed widths that fit 80 columns; numbers right-aligned. */
function table(head: string[], widths: number[], right: boolean[], body: string[][]): string[] {
  const line = (cells: string[]) =>
    cells.map((v, i) => (i === cells.length - 1 ? v : right[i] ? v.padStart(widths[i]!) : cut(v, widths[i]!).padEnd(widths[i]!))).join("  ").trimEnd();
  return [c.dim(line(head)), ...body.map(line)];
}

export function renderStatus(d: StatusData, opts: { limit: number; now?: number } = { limit: 10 }): string {
  const now = opts.now ?? Date.now();
  const out: string[] = [""];
  const stateWord = d.state === "running" ? c.green("running") : c.yellow("stopped");
  const head = table(
    ["STATE", "UPTIME", "LINK", `REQ ${d.window}`, "OK%", "DATA"],
    [8, 8, 12, 8, 4, 0],
    [false, false, false, true, true, false],
    [[d.state, d.uptimeMs === null ? "—" : duration(d.uptimeMs), d.link ?? "—", String(d.requests), d.okPct === null ? "—" : `${d.okPct}%`, d.bytes === null ? "—" : size(d.bytes)]],
  );
  head[1] = head[1]!.replace(/^(running|stopped)/, stateWord);
  out.push(...head);
  if (!d.requests) {
    out.push("", c.dim(`no pod requests in the last ${d.window}`));
  } else {
    out.push("");
    out.push(...table(["POD", "REQ", "OK%", "LAST"], [24, 6, 4, 0], [false, true, true, false],
      d.pods.slice(0, opts.limit).map((p) => [p.name, String(p.requests), `${p.okPct}%`, ago(now - Date.parse(p.lastAt))])));
    out.push("");
    out.push(...table(["SITE", "REQ", "OK%", "LAST ERROR"], [24, 6, 4, 0], [false, true, true, false],
      d.sites.slice(0, opts.limit).map((s) => [s.host, String(s.requests), `${s.okPct}%`,
        s.lastError ? `${s.lastError}, ${ago(now - Date.parse(s.lastErrorAt!))}` : "—"])));
    const hidden = Math.max(0, d.pods.length - opts.limit) + Math.max(0, d.sites.length - opts.limit);
    if (hidden) out.push("", c.dim(`${hidden} more rows — relay status --all`));
  }
  return out.join("\n");
}
