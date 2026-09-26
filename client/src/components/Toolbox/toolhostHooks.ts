/**
 * React Query hooks for the browser-direct Toolhost connection. Global query
 * defaults retry 3× — every hook here opts out (`retry: false`): the Toolhost
 * is probed, not assumed, and a dead port must surface as offline instantly.
 */

import { useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InstallJob, InstallRequestBody, LocalToolRecord } from './toolhost';
import {
  deleteLocalTool,
  fetchHealth,
  fetchInstallJob,
  fetchLocalTools,
  fetchRun,
  fetchRunLogs,
  postInstall,
  postRun,
  postStopRun,
  ToolhostError,
} from './toolhost';
import { pairingCodeAtom, pairingRejectedAtom } from './atoms';
import { mergeCatalogWithLocal } from './toolStatus';
import { useToolsQuery } from './api';

const HEALTH_POLL_MS = 15_000;
const LOCAL_TOOLS_POLL_MS = 30_000;
const INSTALL_JOB_POLL_MS = 1_000;
const RUN_POLL_MS = 1_500;

export function usePairingCode() {
  /* Opt-in pairing atoms live in ./atoms; saving resets the rejected hint. */
  const setCode = useSetAtom(pairingCodeAtom);
  const setRejected = useSetAtom(pairingRejectedAtom);
  const code = useAtomValue(pairingCodeAtom);
  return {
    code,
    saveCode(value: string) {
      setCode(value.trim());
      setRejected(false);
    },
  };
}

/** Shared mutation guard: a 403 means the stored code is invalid/rotated —
 * drop it, flag the chip, and refresh toolhost queries. */
function usePairingGuard() {
  const clearCode = useSetAtom(pairingCodeAtom);
  const setRejected = useSetAtom(pairingRejectedAtom);
  const queryClient = useQueryClient();
  return (error: unknown) => {
    if (error instanceof ToolhostError && error.status === 403) {
      clearCode('');
      setRejected(true);
      void queryClient.invalidateQueries({ queryKey: ['toolhost'] });
    }
  };
}

/** boolean online probe; network errors resolve to `false` (never error state). */
export function useToolhostHealth() {
  return useQuery({
    queryKey: ['toolhost', 'health'],
    queryFn: async () => {
      try {
        await fetchHealth();
        return true;
      } catch {
        return false;
      }
    },
    refetchInterval: HEALTH_POLL_MS,
    retry: false,
  });
}

/** Track B install records only — /v1/local/tools also lists Track A tools. */
export function useLocalTools(online: boolean) {
  return useQuery({
    queryKey: ['toolhost', 'tools'],
    queryFn: () => fetchLocalTools(),
    enabled: online,
    refetchInterval: LOCAL_TOOLS_POLL_MS,
    retry: false,
    select: (data: { tools: LocalToolRecord[] }): LocalToolRecord[] =>
      data.tools.filter((tool) => tool.source === 'tool_package'),
  });
}

/** Catalog × local merge consumed by the sidebar and the tool surface. */
export function useMergedTools() {
  const health = useToolhostHealth();
  const online = health.data === true;
  const catalog = useToolsQuery();
  const local = useLocalTools(online);
  const tools = useMemo(
    () => mergeCatalogWithLocal(catalog.data?.tools ?? [], local.data ?? []),
    [catalog.data, local.data],
  );
  return {
    tools,
    groups: catalog.data?.groups,
    online,
    isLoading: catalog.isLoading,
    error: catalog.error,
  };
}

export function useInstallTool() {
  const guard = usePairingGuard();
  const code = useAtomValue(pairingCodeAtom);
  return useMutation({
    mutationFn: (body: InstallRequestBody) => postInstall(body, code),
    onError: guard,
  });
}

export function useDeleteLocalTool() {
  const guard = usePairingGuard();
  const queryClient = useQueryClient();
  const code = useAtomValue(pairingCodeAtom);
  return useMutation({
    mutationFn: (toolId: string) => deleteLocalTool(toolId, code),
    onError: guard,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['toolhost', 'tools'] }),
  });
}

const INSTALL_JOB_ACTIVE = ['downloading', 'verifying', 'staging'];

/** Poll the install job while active; on a terminal state refresh the local
 * tools list so badges flip without waiting for the 30s interval. */
export function useInstallJob(jobId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['toolhost', 'install-job', jobId],
    queryFn: () => fetchInstallJob(jobId as string),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (job: InstallJob | undefined) =>
      job && INSTALL_JOB_ACTIVE.includes(job.state) ? INSTALL_JOB_POLL_MS : false,
  });
  const state = query.data?.state;
  useEffect(() => {
    if (state === 'installed' || state === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['toolhost', 'tools'] });
    }
  }, [state, queryClient]);
  return query;
}

export function useStartLocalRun() {
  const guard = usePairingGuard();
  const code = useAtomValue(pairingCodeAtom);
  return useMutation({
    /* { arguments } only — `confirmed` is client-side gating, never sent. */
    mutationFn: (vars: { toolId: string; arguments: Record<string, unknown> }) =>
      postRun(vars.toolId, { arguments: vars.arguments }, code),
    onError: guard,
  });
}

export function useLocalRun(runId: string | null) {
  return useQuery({
    queryKey: ['toolhost', 'run', runId],
    queryFn: () => fetchRun(runId as string),
    enabled: !!runId,
    retry: false,
    refetchInterval: (run) =>
      run && (run.status === 'preparing' || run.status === 'running') ? RUN_POLL_MS : false,
  });
}

/** Fetched only while the panel is open (runs are immutable once terminal). */
export function useRunLogs(runId: string | null, open: boolean) {
  return useQuery({
    queryKey: ['toolhost', 'run-logs', runId],
    queryFn: () => fetchRunLogs(runId as string),
    enabled: !!runId && open,
    retry: false,
  });
}

export function useStopRun() {
  const guard = usePairingGuard();
  const queryClient = useQueryClient();
  const code = useAtomValue(pairingCodeAtom);
  return useMutation({
    mutationFn: (runId: string) => postStopRun(runId, code),
    onError: guard,
    onSuccess: (_data, runId) =>
      void queryClient.invalidateQueries({ queryKey: ['toolhost', 'run', runId] }),
  });
}
