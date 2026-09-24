import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecuteResult, LinkPoll, LinkState, NextcloudStatus, ToolManifest } from './types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = body?.detail ?? body;
    const message =
      typeof detail === 'string'
        ? detail
        : (detail?.message ?? detail?.detail ?? JSON.stringify(detail));
    const error = new Error(message) as Error & {
      status?: number;
      code?: string;
      payload?: unknown;
    };
    error.status = res.status;
    error.code = typeof detail === 'object' && detail !== null ? detail.code : undefined;
    error.payload = detail;
    throw error;
  }
  return body as T;
}

export const useToolsQuery = (front: 'ui' | 'mcp' = 'ui') =>
  useQuery({
    queryKey: ['terravox', 'tools', front],
    queryFn: () =>
      api<{ tools: ToolManifest[] }>(`/api/terravox/tools?front=${front}`).then(
        (d) => d.tools ?? [],
      ),
  });

export const useNextcloudStatus = () =>
  useQuery({
    queryKey: ['terravox', 'nextcloud', 'status'],
    queryFn: () => api<NextcloudStatus>('/api/terravox/nextcloud/status'),
  });

export const useStartLink = () =>
  useMutation({
    mutationFn: () => api<LinkState>('/api/terravox/nextcloud/link', { method: 'POST' }),
  });

export const usePollLink = (linkId: string | null) =>
  useQuery({
    queryKey: ['terravox', 'nextcloud', 'link', linkId],
    enabled: !!linkId,
    refetchInterval: (data) => (data?.status === 'pending' ? 3000 : false),
    queryFn: () => api<LinkPoll>(`/api/terravox/nextcloud/link/${linkId}`),
  });

export const useUnlink = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ unlinked: boolean }>('/api/terravox/nextcloud/link', { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['terravox', 'nextcloud'] }),
  });
};

export const useExecuteTool = (toolId: string) =>
  useMutation({
    mutationFn: (args: { params: Record<string, unknown>; confirmed?: boolean }) =>
      api<ExecuteResult>(`/api/terravox/tools/${encodeURIComponent(toolId)}/execute`, {
        method: 'POST',
        body: JSON.stringify(args),
      }),
  });
