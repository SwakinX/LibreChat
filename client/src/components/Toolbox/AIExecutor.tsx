import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalPending, useResolveLocalPending, type LocalPending } from './api';
import { usePairingCode, useLocalRun, useStartLocalRun } from './toolhostHooks';
import { fetchPairingCode, fetchRuns, ToolhostError } from './toolhost';

/**
 * AI 本机执行器（local-tool-plan §9 / contracts 2.28.0，全局挂载于 Root）。
 *
 * **无 UI**（用户指示 2026-10-08：对话里的运行指示已足够）：轮询 gateway 的
 * pending 清单，在本机启动 Toolhost 运行、轮询终态、把结果回传 gateway——
 * 挂起的 MCP 调用随即完成，模型同轮拿到结果。批准语义由聊天里的原生 HITL
 * 审批承担（参数已在审批卡过目，gateway 侧亦已 schema 校验）；铁律不变——
 * 浏览器是本地执行的唯一发起方。
 *
 * 启动失败的自愈（顺序）：403 配对码失效 → 清码 + 免 token 取新码重跑一次；
 * 其他启动错误（含客户端超时中止——arcpy 等运行时冷启动会超过客户端超时，
 * 而 Toolhost 侧 run 其实已经启动，用户实测「signal is aborted」但工具仍在
 * 运行）→ 探测该工具近 5 分钟内的活动 run 并接管轮询；都没有才把 failed
 * 回传给模型。
 */

/** Cross-tab claim: exactly one tab runs a given pending. localStorage is
 * synchronous, so the race window is negligible; a crashed claimant just
 * costs the run its gateway timeout instead of a duplicate execution. */
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
  return (
    <>
      {items.map((item) => (
        <PendingExecution key={item.id} item={item} />
      ))}
    </>
  );
}

function PendingExecution({ item }: { item: LocalPending }) {
  const queryClient = useQueryClient();
  const resolve = useResolveLocalPending();
  const startRun = useStartLocalRun();
  const [runId, setRunId] = useState<string | null>(null);
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
          /* 终态已记账——刷新清单让本执行实例退场（回传被 409 拒绝同样退场） */
          void queryClient.invalidateQueries({ queryKey: ['terravox', 'local-pending'] });
        },
      },
    );
  };

  const failNow = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    finish('failed', message);
  };

  /** 启动请求超时中止 ≠ 没启动：Toolhost 侧 run 往往已在跑（慢运行时冷启动）。
   *  找到该工具近 5 分钟内的活动 run 就接管轮询；返回 null 表示确实没启动。 */
  const adoptOrphanRun = async (): Promise<string | null> => {
    try {
      const { runs } = await fetchRuns({ toolId: item.tool_id, limit: 10 });
      const cutoff = startedAt.current - 5 * 60_000;
      const active = runs.find(
        (r) =>
          (r.status === 'running' || r.status === 'preparing') &&
          new Date(r.created_at ?? 0).getTime() >= cutoff,
      );
      return active?.run_id ?? null;
    } catch {
      return null;
    }
  };

  const launch = () => {
    startRun.mutate(
      { toolId: item.tool_id, arguments: item.params },
      {
        onSuccess: (job) => setRunId(job.run_id),
        onError: (err) => {
          /* 403 = 配对码缺失/轮换（换 Toolhost、删码重启都会轮换）——与工具箱
             同款自愈：useStartLocalRun 的守卫已清旧码，这里免 token 取新码后
             自动重跑一次。 */
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
          /* 其他启动失败（典型：客户端超时中止）→ 先尝试接管孤儿 run */
          void adoptOrphanRun().then((orphan) => {
            if (orphan) {
              setRunId(orphan);
            } else {
              failNow(err);
            }
          });
        },
      },
    );
  };

  /* Start exactly once (StrictMode double-effect included via started ref +
   * the localStorage claim). */
  useEffect(() => {
    if (claimLost) {
      return;
    }
    if (started.current) {
      return;
    }
    if (!claimPending(item.id)) {
      /* 另一个标签页已认领——本标签页完全退场 */
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

  return null;
}
