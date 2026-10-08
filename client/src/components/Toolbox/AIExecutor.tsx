import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, MonitorPlay, Square, TriangleAlert } from 'lucide-react';
import { usePairingCode, useLocalRun, useStartLocalRun, useStopRun } from './toolhostHooks';
import { useLocalPending, useResolveLocalPending, type LocalPending } from './api';
import { fetchPairingCode, ToolhostError } from './toolhost';
import { useLocalize } from '~/hooks';

/**
 * AI 本机执行器（local-tool-plan §9 / contracts 2.28.0，全局挂载于 Root）。
 *
 * 模型经 MCP 调 desktop 工具时 gateway 挂起该调用并建 pending；本组件轮询
 * pending 清单，在本机启动 Toolhost 运行、轮询终态、把结果回传 gateway——
 * 挂起的 MCP 调用随即完成，模型同轮拿到结果。批准语义由聊天里的原生 HITL
 * 审批承担（卡片不做二次确认，参数已在审批卡过目，gateway 侧亦已 schema
 * 校验）；服务端铁律不变——浏览器是本地执行的唯一发起方。
 */

/** Cross-tab claim: exactly one tab runs a given pending. localStorage is
 * synchronous, so the race window is negligible; a crashed claimant just
 * costs the run its gateway timeout (100s) instead of a duplicate execution. */
function claimPending(id: string): boolean {
  const key = `terravox-ai-claim-${id}`;
  if (localStorage.getItem(key)) {
    return false;
  }
  localStorage.setItem(key, '1');
  return true;
}

export default function AIExecutor() {
  const { data } = useLocalPending();
  const items = data?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <div
      className="fixed bottom-4 end-4 z-50 flex w-80 flex-col gap-2"
      role="region"
      aria-label="AI local execution"
    >
      {items.map((item) => (
        <PendingCard key={item.id} item={item} />
      ))}
    </div>
  );
}

function PendingCard({ item }: { item: LocalPending }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const resolve = useResolveLocalPending();
  const startRun = useStartLocalRun();
  const stopRun = useStopRun();
  const [runId, setRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [claimLost, setClaimLost] = useState(false);
  const started = useRef(false);
  const reported = useRef(false);
  const repaired = useRef(false);
  const startedAt = useRef<number>(Date.now());
  const run = useLocalRun(runId);
  const { saveCode } = usePairingCode();

  const finish = (
    status: 'succeeded' | 'failed' | 'stopped' | 'timeout',
    error?: string | null,
    result?: unknown,
  ) => {
    if (reported.current) {
      return;
    }
    reported.current = true;
    setReporting(true);
    resolve.mutate(
      {
        id: item.id,
        status,
        duration_ms: Date.now() - startedAt.current,
        ...(error ? { error } : {}),
        ...(status === 'succeeded' ? { result } : {}),
      },
      {
        onSettled: () => {
          /* 终态已记账——刷新清单让卡片退场（回传被 409 拒绝同样退场） */
          void queryClient.invalidateQueries({ queryKey: ['terravox', 'local-pending'] });
        },
      },
    );
  };

  const failNow = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setStartError(message);
    finish('failed', message);
  };

  const launch = () => {
    startRun.mutate(
      { toolId: item.tool_id, arguments: item.params },
      {
        onSuccess: (job) => setRunId(job.run_id),
        onError: (err) => {
          /* 403 = 配对码缺失/轮换（换 Toolhost、删码重启都会轮换）——与工具箱
             同款自愈：useStartLocalRun 的守卫已清旧码，这里免 token 取新码后
             自动重跑一次；仍失败才把 failed 回传给模型。 */
          if (err instanceof ToolhostError && err.status === 403 && !repaired.current) {
            repaired.current = true;
            saveCode('');
            fetchPairingCode()
              .then((code) => {
                if (code) {
                  saveCode(code);
                }
                launch();
              })
              .catch(failNow);
            return;
          }
          failNow(err);
        },
      },
    );
  };

  /* Start exactly once (StrictMode double-effect included via started ref +
   * the localStorage claim). A start failure resolves the pending as failed —
   * the waiting model must never hang past the gateway budget on a dead
   * Toolhost; the error surfaces in the conversation. */
  useEffect(() => {
    if (claimLost) {
      return;
    }
    if (started.current) {
      return;
    }
    if (!claimPending(item.id)) {
      /* 另一个标签页已认领——本标签页完全退场（不渲染、不轮询、不回传） */
      setClaimLost(true);
      return;
    }
    started.current = true;
    startedAt.current = Date.now();
    launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, claimLost]);

  /* Terminal run → same-turn report back to the gateway. */
  useEffect(() => {
    const status = run.data?.status;
    if (!status || status === 'preparing' || status === 'running') {
      return;
    }
    finish(status, run.data?.error ?? null, status === 'succeeded' ? run.data?.result : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.data?.status]);

  if (claimLost) {
    return null;
  }

  if (startError) {
    return (
      <div
        className="rounded-xl border border-border-light bg-surface-primary-alt p-3 shadow-lg"
        data-testid="ai-executor-card"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <MonitorPlay className="size-4 text-amber-500" aria-hidden="true" />
          {item.tool_name}
        </div>
        <p className="text-text-error mt-1 flex items-start gap-1.5 text-xs" role="alert">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {localize('com_aiexec_start_failed', { 0: startError })}
        </p>
      </div>
    );
  }

  const runStatus = run.data?.status;
  const active =
    reporting === false &&
    (runStatus === 'preparing' || runStatus === 'running' || runStatus == null);
  let phaseKey: string;
  if (reporting) {
    phaseKey = 'com_aiexec_reporting';
  } else if (runStatus === 'preparing' || runStatus === 'running') {
    phaseKey = 'com_aiexec_running';
  } else {
    phaseKey = 'com_aiexec_starting';
  }

  return (
    <div
      className="rounded-xl border border-border-light bg-surface-primary-alt p-3 shadow-lg"
      data-testid="ai-executor-card"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <MonitorPlay className="size-4 text-amber-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{item.tool_name}</span>
        {active && runId && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-medium px-1.5 py-0.5 text-xs text-text-primary transition-colors hover:bg-surface-hover"
            onClick={() => stopRun.mutate(runId)}
          >
            <Square className="size-3" aria-hidden="true" />
            {localize('com_aiexec_stop')}
          </button>
        )}
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {localize(phaseKey)}
      </p>
    </div>
  );
}
