/**
 * Browser-direct client for the local TerraVox Toolhost — the only fetch in
 * the app that does NOT go through the `/api/terravox/*` server proxy. The
 * Toolhost is addressed by the 127.0.0.1 literal (never `localhost`: PNA and
 * the origin whitelist are keyed on it) and answers CORS preflights with
 * Access-Control-Allow-Private-Network.
 *
 * Mutations carry the persistent pairing code via X-Approval-Token (injected
 * only when one is stored); read-only GETs stay token-free. A 403 on any
 * mutation means the code is invalid/rotated — hooks clear it and the status
 * chip reverts to the pairing input.
 */

export const TOOLHOST_BASE = 'http://127.0.0.1:8765';

/** /v1/local/tools entries with source === 'tool_package' (Track B installs). */
export type LocalToolRecord = {
  tool_id: string;
  source: string;
  /** 1.4.0: 'plugin' for host-plugin packages, 'automation' otherwise. */
  kind?: string | null;
  /** Plugin block (1.4.0) — present for host-plugin packages. */
  plugin?: {
    host_root?: string;
    host_launcher?: string;
    host_root_hints?: string[];
    install_script?: string;
    uninstall_script?: string;
  } | null;
  name?: string | null;
  description?: string | null;
  installed_version?: string | null;
  owner?: string | null;
  repo?: string | null;
  launcher?: string | null;
  runtime?: string | null;
  dangerous?: boolean;
  /** Computed file-presence flag (toolhost-local/v1 1.3.0): install dir or
   * launcher missing — run is refused with 409 until a reinstall repairs it. */
  damaged?: boolean;
  timeout_minutes?: number | null;
  parameters?: {
    type: 'object';
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  } | null;
  form?: {
    order?: string[];
    fields?: Record<string, unknown>;
  } | null;
  result?: { renderer?: string; config?: Record<string, unknown> } | null;
  installed_at?: string | null;
};

export type InstallJobState = 'downloading' | 'verifying' | 'staging' | 'installed' | 'failed';

export type InstallJobErrorCode =
  | 'resolve_failed'
  | 'download_failed'
  | 'host_not_allowed'
  | 'checksum_mismatch'
  | 'invalid_tool_package'
  | 'archive_invalid'
  | 'launcher_missing'
  | 'version_conflict'
  | 'internal';

export type InstallJob = {
  job_id: string;
  tool_id: string;
  owner: string;
  repo: string;
  version: string;
  state: InstallJobState;
  /** Download progress only; null outside downloading or without Content-Length. */
  progress_percent: number | null;
  already_installed?: boolean;
  error: { code: InstallJobErrorCode | string; message: string } | null;
  created_at: string;
  finished_at: string | null;
};

export type LocalRunStatus =
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'timeout';

export type LocalRun = {
  run_id: string;
  tool_id: string;
  version?: string | null;
  status: LocalRunStatus;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  error?: string | null;
  arguments?: Record<string, unknown>;
  /** Tool stdout JSON; null until the run sets it (no declared result → stays null). */
  result?: unknown;
  created_at?: string;
};

export class ToolhostError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ToolhostError';
    this.status = status;
    this.code = code;
  }
}

async function toolhostFetch(
  path: string,
  { timeoutMs = 15000, ...init }: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    /* This is a browser fetch to the user's own machine — deliberately not
     * the data-provider axios instance (which would hit the chat origin). */
    return await fetch(`${TOOLHOST_BASE}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { detail?: unknown };
      const detail = body?.detail;
      if (typeof detail === 'string') {
        message = detail;
      } else if (detail && typeof detail === 'object') {
        const shaped = detail as { message?: string; code?: string };
        message = shaped.message ?? message;
        code = shaped.code;
      }
    } catch {
      /* non-JSON body — keep the status message */
    }
    throw new ToolhostError(response.status, message, code);
  }
  return (await response.json()) as T;
}

/** Approval header only when a code is stored — sending a blank token would 403. */
function approvalHeaders(pairingCode: string): Record<string, string> {
  return pairingCode ? { 'X-Approval-Token': pairingCode } : {};
}

const jsonHeaders = (pairingCode: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...approvalHeaders(pairingCode),
});

/** Native file/directory dialog on the Toolhost machine (toolhost-local
 * 1.5.0): browsers never see local paths, so path widgets ask the local
 * service to open the real Windows dialog. Returns null on cancel. */
export async function pickLocalPath(
  mode: 'file' | 'directory',
  title?: string,
  accept?: string[],
): Promise<string | null> {
  const response = await toolhostFetch('/v1/local/fs/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, title, accept }),
    timeoutMs: 10 * 60_000, // dialog stays open as long as the user needs
  });
  const payload = (await parse<{ path: string | null }>(response)) ?? { path: null };
  return payload.path;
}

export async function fetchHealth(): Promise<{ status: string }> {
  return parse(await toolhostFetch('/healthz', { timeoutMs: 2000 }));
}

/** Open the plugin's recorded host directory in Explorer (toolhost-local
 * 1.8.0). The path is the one recorded at install time on the Toolhost side —
 * never a client-supplied path. */
export async function openPluginHostDir(toolId: string, pairingCode: string): Promise<void> {
  await parse(
    await toolhostFetch(`/v1/local/tools/${encodeURIComponent(toolId)}/open-host-dir`, {
      method: 'POST',
      headers: approvalHeaders(pairingCode),
    }),
  );
}

/** Auto-pairing bootstrap (toolhost-local/v1 1.2.0): token-free on purpose —
 * this endpoint exists to hand the credential to the whitelisted origin. */
export async function fetchPairingCode(): Promise<string> {
  const payload = await parse<{ code: string }>(
    await toolhostFetch('/v1/local/pairing-code', { timeoutMs: 5000 }),
  );
  return payload.code;
}

export async function fetchLocalTools(): Promise<{ tools: LocalToolRecord[] }> {
  return parse(await toolhostFetch('/v1/local/tools'));
}

export type InstallRequestBody = {
  tool_id: string;
  owner: string;
  repo: string;
  /** Omitted = latest stable; explicit for the update path. */
  version?: string;
  /** Gateway-registered supplemental fields (never browser-supplied URLs). */
  fallback?: {
    version?: string;
    package_sha256?: string;
    launcher?: string;
    runtime?: string;
    host_launcher?: string;
    host_root_hints?: string[];
    install_script?: string;
    uninstall_script?: string;
  };
  /** Plugin packages (1.4.0): the user-selected host software root. */
  plugin?: { host_root: string };
};

export async function postInstall(
  body: InstallRequestBody,
  pairingCode: string,
): Promise<InstallJob> {
  return parse(
    await toolhostFetch('/v1/local/tools/install', {
      method: 'POST',
      headers: jsonHeaders(pairingCode),
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchInstallJob(jobId: string): Promise<InstallJob> {
  return parse(await toolhostFetch(`/v1/local/install-jobs/${encodeURIComponent(jobId)}`));
}

export async function deleteLocalTool(
  toolId: string,
  pairingCode: string,
): Promise<{ tool_id: string; deleted: boolean; removed_versions?: string[] }> {
  return parse(
    await toolhostFetch(`/v1/local/tools/${encodeURIComponent(toolId)}`, {
      method: 'DELETE',
      headers: approvalHeaders(pairingCode),
    }),
  );
}

export type RunStarted = {
  /** Null for web-launch tools (desktop packages always return a run_id). */
  run_id: string | null;
  launch_event_id?: string;
  status?: string;
};

export async function postRun(
  toolId: string,
  body: { arguments: Record<string, unknown>; version?: string },
  pairingCode: string,
): Promise<RunStarted> {
  return parse(
    await toolhostFetch(`/v1/local/tools/${encodeURIComponent(toolId)}/runs`, {
      method: 'POST',
      headers: jsonHeaders(pairingCode),
      /* 120s：慢运行时（arcpy conda env 等）的冷启动会超过默认 15s——
       * 客户端中止时 Toolhost 侧 run 其实照常启动（孤儿 run），2026-10-08。 */
      timeoutMs: 120_000,
      /* RunRequest is extra=forbid — the dangerous-tool confirmation gate is
       * purely client-side and `confirmed` must never be sent. */
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchRun(runId: string): Promise<LocalRun> {
  return parse(await toolhostFetch(`/v1/local/runs/${encodeURIComponent(runId)}`));
}

/** Run history for the tool-page bottom section (toolhost-local/v1 1.3.0):
 * newest first, list items carry no artifacts. */
export async function fetchRuns(
  opts: { toolId?: string; limit?: number } = {},
): Promise<{ runs: LocalRun[] }> {
  const params = new URLSearchParams();
  if (opts.toolId) {
    params.set('tool_id', opts.toolId);
  }
  if (opts.limit != null) {
    params.set('limit', String(opts.limit));
  }
  const query = params.toString();
  return parse(await toolhostFetch(`/v1/local/runs${query ? `?${query}` : ''}`));
}

export async function fetchRunLogs(runId: string): Promise<{ stdout: string[]; stderr: string[] }> {
  return parse(await toolhostFetch(`/v1/local/runs/${encodeURIComponent(runId)}/logs`));
}

export async function postStopRun(
  runId: string,
  pairingCode: string,
): Promise<{ run_id: string; status: string }> {
  return parse(
    await toolhostFetch(`/v1/local/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      headers: approvalHeaders(pairingCode),
    }),
  );
}
