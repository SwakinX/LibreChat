/**
 * Local cache of server-tool run params/results (keyed by run_id), so the
 * tool-page history section can show what a run did and restore its params
 * into the form. The gateway's usage records intentionally store only
 * argument KEY NAMES (audit constraint) — the values stay in this browser,
 * 20 entries per tool, nothing leaves the machine.
 */

export type CachedRun = {
  run_id: string;
  params: Record<string, unknown>;
  result?: unknown;
  ts: number;
};

const MAX_PER_TOOL = 20;
const keyFor = (toolId: string) => `terravox:runhistory:${toolId}`;

export function loadCachedRuns(toolId: string): CachedRun[] {
  try {
    const raw = localStorage.getItem(keyFor(toolId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as CachedRun[]) : [];
  } catch {
    return [];
  }
}

export function cacheRun(toolId: string, entry: CachedRun): void {
  try {
    const next = [entry, ...loadCachedRuns(toolId).filter((r) => r.run_id !== entry.run_id)];
    localStorage.setItem(keyFor(toolId), JSON.stringify(next.slice(0, MAX_PER_TOOL)));
  } catch {
    /* storage full/unavailable — history caching is best-effort */
  }
}

export function getCachedRun(toolId: string, runId: string): CachedRun | undefined {
  return loadCachedRuns(toolId).find((r) => r.run_id === runId);
}
