import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopPid } from "../src/stop.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("relay stop never hangs (owner's DS118: `relay stop` took over a minute, 2026-11-08)", () => {
  it("kills a daemon that ignores SIGTERM within the grace window", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200)); // let it install the handler
    const dir = mkdtempSync(path.join(tmpdir(), "relay-stop-"));
    const pidFile = path.join(dir, "relay.pid");
    writeFileSync(pidFile, String(child.pid));
    const t = Date.now();
    const how = await stopPid(child.pid!, { graceMs: 600, pollMs: 50, files: [pidFile] });
    expect(how).toBe("killed");
    expect(Date.now() - t).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(child.pid!)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("waits for a daemon that exits on SIGTERM and reports it stopped", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await stopPid(child.pid!, { graceMs: 3000, pollMs: 50 })).toBe("stopped");
    expect(alive(child.pid!)).toBe(false);
  });

  it("returns at once when nothing is running", async () => {
    const t = Date.now();
    expect(await stopPid(2 ** 22 + 12345, { graceMs: 5000 })).toBe("not-running");
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("short commands stay light on a slow NAS", () => {
  it("`relay status` and `relay stop` load no transport, browser or dashboard module", () => {
    const main = path.join(here, "../dist/main.js");
    const home = mkdtempSync(path.join(tmpdir(), "relay-home-"));
    for (const cmd of ["status", "stop"]) {
      const r = spawnSync(process.execPath, ["--import", path.join(here, "fixtures/trace-imports.mjs"), main, cmd], {
        env: { ...process.env, HOME: home }, encoding: "utf8",
      });
      const loaded = r.stderr.split("\n").filter((l) => l.startsWith("LOAD ")).join("\n");
      expect(loaded).toContain("main.js"); // the trace works
      for (const heavy of ["dashboard.js", "relay-client.js", "relay-tunnel.js", "browser-fetcher.js", "/ws/", "playwright"]) {
        expect(loaded, `${cmd} loaded ${heavy}`).not.toContain(heavy);
      }
    }
  });
});
