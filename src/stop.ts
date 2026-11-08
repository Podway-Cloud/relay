import { unlinkSync } from "node:fs";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Stop a relay daemon and WAIT until it is gone, but never for long: SIGTERM, poll for up to
 * `graceMs`, then SIGKILL. A boot script runs `relay stop` before `relay start`, so returning
 * while the old daemon still holds the dashboard port or the browser profile would race the new
 * one — and a daemon stuck in a slow shutdown (a swapping NAS) must not hang the script.
 */
export async function stopPid(
  pid: number,
  opts: { graceMs?: number; pollMs?: number; files?: string[] } = {},
): Promise<"not-running" | "stopped" | "killed"> {
  const { graceMs = 5000, pollMs = 100, files = [] } = opts;
  const clean = () => { for (const f of files) try { unlinkSync(f); } catch { /* gone */ } };
  if (!alive(pid)) { clean(); return "not-running"; }
  try { process.kill(pid, "SIGTERM"); } catch { /* exited meanwhile */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) { clean(); return "stopped"; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* exited at the last moment */ }
  clean();
  return "killed";
}
