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
