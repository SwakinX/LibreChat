import { request } from 'librechat-data-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecuteResult, LinkPoll, LinkState, NextcloudStatus, ToolManifest } from './types';

type ApiError = Error & { status?: number; code?: string; payload?: unknown };

/**
 * All calls go through the shared data-provider axios instance, which carries the
 * app JWT (set by AuthContext) and the 401 refresh/retry interceptors — a raw
 * fetch() here would hit requireJwtAuth without a token and fail with 401.
 */
function toError(err: unknown): ApiError {
  const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
  const raw = axiosErr.response?.data;
  const detail = (raw as { detail?: unknown } | undefined)?.detail ?? raw;
  const message =
    typeof detail === 'string'
      ? detail
      : ((detail as { message?: string } | undefined)?.message ?? axiosErr.message ?? String(err));
  const error = new Error(message) as ApiError;
  error.status = axiosErr.response?.status;
  error.code =
    typeof detail === 'object' && detail !== null ? (detail as { code?: string }).code : undefined;
  error.payload = detail;
  return error;
}

async function get<T>(url: string): Promise<T> {
  try {
    return (await request.get(url)) as T;
  } catch (err) {
    throw toError(err);
  }
}

async function post<T>(url: string, data?: unknown): Promise<T> {
  try {
    return (await request.post(url, data)) as T;
  } catch (err) {
    throw toError(err);
  }
}

async function del<T>(url: string): Promise<T> {
  try {
    return (await request.delete(url)) as T;
  } catch (err) {
    throw toError(err);
  }
}

export type CatalogGroup = {
  name: string;
  display_name: string;
  sort_order: number;
};

export type ToolCatalog = {
  tools: ToolManifest[];
  /** Group metadata from the gateway (additive; absent on older gateways). */
  groups?: CatalogGroup[];
};

export const useToolsQuery = (front: 'ui' | 'mcp' = 'ui') =>
  useQuery({
    queryKey: ['terravox', 'tools', front],
    queryFn: () => get<ToolCatalog>(`/api/terravox/tools?front=${front}`),
  });

export const useNextcloudStatus = () =>
  useQuery({
    queryKey: ['terravox', 'nextcloud', 'status'],
    queryFn: () => get<NextcloudStatus>('/api/terravox/nextcloud/status'),
  });

export const useStartLink = () =>
  useMutation({
    mutationFn: () => post<LinkState>('/api/terravox/nextcloud/link'),
  });

export const usePollLink = (linkId: string | null) =>
  useQuery({
    queryKey: ['terravox', 'nextcloud', 'link', linkId],
    enabled: !!linkId,
    refetchInterval: (data) => (data?.status === 'pending' ? 3000 : false),
    queryFn: () => get<LinkPoll>(`/api/terravox/nextcloud/link/${linkId}`),
  });

export const useUnlink = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => del<{ unlinked: boolean }>('/api/terravox/nextcloud/link'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['terravox', 'nextcloud'] }),
  });
};

export const useExecuteTool = (toolId: string) =>
  useMutation({
    mutationFn: (args: { params: Record<string, unknown>; confirmed?: boolean }) =>
      post<ExecuteResult>(`/api/terravox/tools/${encodeURIComponent(toolId)}/execute`, args),
  });

export type RunReportBody = {
  tool_id: string;
  version?: string;
  /** Terminal local-run status (preparing/running are never reported). */
  status: 'succeeded' | 'failed' | 'stopped' | 'timeout';
  duration_ms: number;
  /** Top-level argument names only — values never leave the machine. */
  argument_keys?: string[];
};

/** Best-effort direct-run report for the usage stats (local-tool-plan §8).
 * Failures are swallowed: the server is not on the local execution path. */
export const useReportToolRun = () =>
  useMutation({
    mutationFn: (body: RunReportBody) =>
      post<{ recorded: boolean }>('/api/terravox/runs/report', body),
    onError: () => undefined,
  });

export type MyRun = {
  id: string;
  tool_id: string;
  version?: string | null;
  status: 'succeeded' | 'failed' | 'stopped' | 'timeout';
  duration_ms?: number | null;
  source?: string;
  created_at: string;
};

export type MyRunList = { runs: MyRun[]; total: number };

/** Current user's own usage records (gateway run_reports, contracts 2.10.0) —
 * data source for the server-tool run-history section. Mirrors the Toolhost
 * hook: 30s freshness, no retries (the section degrades to the empty state). */
export const useMyRunsForTool = (toolId: string) =>
  useQuery({
    queryKey: ['terravox', 'myruns', toolId],
    queryFn: () =>
      get<MyRunList>(`/api/terravox/runs?tool_id=${encodeURIComponent(toolId)}&limit=200`),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });

export type ChoiceOption = { value: string; label: string };

/** Run a tool with no params and shape its result into select options —
 * the `choices_from` source contract (2.11.0): result is an array of objects
 * (or {rows[]}/{items[]} wrapped); value/label fields default to id/name;
 * non-object rows fall back to their string form. */
async function fetchChoices(
  tool: string,
  valueField?: string,
  labelField?: string,
): Promise<ChoiceOption[]> {
  const result = await post<unknown>(`/api/terravox/tools/${encodeURIComponent(tool)}/execute`, {
    params: {},
  });
  let rows: unknown = (result as { result?: unknown }).result ?? result;
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
    const wrapped = rows as { rows?: unknown; items?: unknown };
    rows = wrapped.rows ?? wrapped.items ?? [];
  }
  if (!Array.isArray(rows)) {
    return [];
  }
  const vKey = valueField || 'id';
  const lKey = labelField || 'name';
  return rows
    .map((row) => {
      if (row && typeof row === 'object') {
        const record = row as Record<string, unknown>;
        const value = record[vKey];
        const label = record[lKey] ?? value;
        return {
          value: value == null ? '' : String(value),
          label: label == null ? '' : String(label),
        };
      }
      return { value: String(row), label: String(row) };
    })
    .filter((option) => option.value !== '');
}

/** Dynamic select options from another tool (manifest form.fields.*.choices_from).
 * Source must be callable with empty params and exposed to the ui front. */
export const useChoicesFrom = (
  source: { tool: string; value_field?: string; label_field?: string } | undefined,
) =>
  useQuery({
    queryKey: ['terravox', 'choices', source?.tool, source?.value_field, source?.label_field],
    queryFn: () => fetchChoices(source?.tool as string, source?.value_field, source?.label_field),
    enabled: !!source?.tool,
    staleTime: 5 * 60_000,
    retry: false,
  });

export type MapConfig = {
  configured: boolean;
  map_url: string;
  center: [number, number];
  zoom: number;
  epsg?: number | null;
};

/** iServer map service root + initial view for the map panel. The browser
 * talks to the iServer origin address directly (2026-09-29); spatial data
 * queries still go through the gateway, so no credentials reach the browser. */
export const useMapConfig = () =>
  useQuery({
    queryKey: ['terravox', 'map', 'config'],
    queryFn: () => get<MapConfig>('/api/terravox/map/config'),
    staleTime: 10 * 60_000,
    retry: false,
  });

/** Multipart execute channel for upload-widget tools (2.15.0): the file bytes
 * stream to the gateway untouched; the JSON params ride along as a form field. */
export async function executeUpload(
  toolId: string,
  args: { file: File; params: Record<string, unknown>; confirmed?: boolean },
): Promise<ExecuteResult> {
  const form = new FormData();
  form.append('file', args.file);
  form.append('params', JSON.stringify(args.params));
  if (args.confirmed) {
    form.append('confirmed', 'true');
  }
  try {
    return (await request.post(
      `/api/terravox/tools/${encodeURIComponent(toolId)}/execute-upload`,
      form,
    )) as ExecuteResult;
  } catch (err) {
    throw toError(err);
  }
}

/** Stream a file from the download proxy and hand it to the browser. */
export async function downloadProxyFile(url: string, filename: string): Promise<void> {
  const blob = (await request.get(url, { responseType: 'blob' })) as Blob;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export type ServiceBinding = {
  id: string;
  name: string;
  type: 'iserver_map' | 'iserver_data';
  base_url: string;
  service_path: string;
  datasource: string;
  allowed_groups: string[];
  enabled: boolean;
  status: string;
  probe_detail: string;
  probed_at: string | null;
};

export type ServiceList = { services: ServiceBinding[]; total: number };

/** Visible service bindings (contracts 2.16.0): the gateway filters by the
 * user's groups — this is the map browser's layer-tree source. */
export const useServices = () =>
  useQuery({
    queryKey: ['terravox', 'services'],
    queryFn: () => get<ServiceList>('/api/terravox/services'),
    staleTime: 60_000,
  });

export type ResolveResult = {
  type: 'iserver_map' | 'iserver_data';
  base: string;
  service_path: string;
  status: string;
  detail: string;
  draft: {
    maps?: string[];
    epsg?: number;
    datasources?: string[];
    dataset_counts?: Record<string, number>;
    datasets?: Record<string, string[]>;
  };
};

/** Resolve a pasted iServer REST URL into type + candidates (2.16.0 direct-add
 * temp layers). Read-only probe — nothing is written to the registry. */
export const useResolveService = () =>
  useMutation({
    mutationFn: (url: string) => post<ResolveResult>('/api/terravox/services/resolve', { url }),
  });
