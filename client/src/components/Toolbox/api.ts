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
