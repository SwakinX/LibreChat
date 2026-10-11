import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Spinner } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleSlash, Loader2, Play, Square, Trash2, Wrench } from 'lucide-react';
import type { InstallRequestBody, InstallJob, LocalRun } from './toolhost';
import type { ExecuteResult, ToolManifest } from './types';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { MergedTool } from './toolStatus';
import {
  useDeleteLocalTool,
  useInstallJob,
  useInstallTool,
  useLocalRun,
  useRunLogs,
  useRunsForTool,
  useStartLocalRun,
  useStopRun,
  useToolhostHealth,
} from './toolhostHooks';
import { RunRecordsSection, type RunRecordRow } from './RunRecordsSection';
import { isDesktopTool } from './toolStatus';
import { useReportToolRun } from './api';
import { useLocalize } from '~/hooks';
import SchemaForm from './SchemaForm';
import ResultView from './ResultView';
import { cn } from '~/utils';

const STAGE_KEYS: Record<string, TranslationKeys> = {
  downloading: 'com_toolbox_stage_downloading',
  verifying: 'com_toolbox_stage_verifying',
  staging: 'com_toolbox_stage_staging',
  installing: 'com_toolbox_stage_installing',
};

/** InstallJobError.code → localized line (raw message shown as a sub-line). */
const ERROR_KEYS: Record<string, TranslationKeys> = {
  resolve_failed: 'com_toolbox_err_resolve_failed',
  download_failed: 'com_toolbox_err_download_failed',
  host_not_allowed: 'com_toolbox_err_host_not_allowed',
  checksum_mismatch: 'com_toolbox_err_checksum_mismatch',
  invalid_tool_package: 'com_toolbox_err_invalid_tool_package',
  archive_invalid: 'com_toolbox_err_archive_invalid',
  launcher_missing: 'com_toolbox_err_launcher_missing',
  version_conflict: 'com_toolbox_err_version_conflict',
  host_root_invalid: 'com_toolbox_err_host_root_invalid',
  install_script_failed: 'com_toolbox_err_install_script_failed',
  uninstall_script_failed: 'com_toolbox_err_uninstall_script_failed',
  internal: 'com_toolbox_err_internal',
};

/** JobPanel + badge logic shared with the plugin runner (1.4.0). */
export function InstallJobPanel({
  job,
  version,
}: {
  job: InstallJob | null | undefined;
  version?: string;
}) {
  return <JobPanel job={job} version={version} />;
}

const TERMINAL_RUN_STATES = ['failed', 'timeout', 'stopped'];
/** Terminal run status → localized headline. */
const RUN_FAIL_KEYS: Record<string, TranslationKeys> = {
  failed: 'com_toolbox_run_failed',
  timeout: 'com_toolbox_run_timeout',
  stopped: 'com_toolbox_run_stopped',
};

/**
 * Desktop-tool surface: install/update/remove with live job progress, plus
 * local execution (params JSON → argv, result rendered inline). The installed
 * record is authoritative for the form and renderer — it keeps working with
 * Gitea offline; the catalog manifest is the preview fallback.
 */
export default function LocalRunner({ tool }: { tool: MergedTool }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { manifest, local, status, latestVersion } = tool;
  /* manifest（Gateway 落库版）是运行时权威（local-tool-plan §4.2）——后台改参数/
   * 表单/渲染即时生效；本地包内 tool.json 只在清单缺字段时离线兜底（Gitea 断网、
   * 目录缓存不可用）。2026-10-08 翻转：原「已装记录优先」导致后台改参不生效。 */
  const effectiveManifest = useMemo<ToolManifest>(
    () => ({
      ...manifest,
      parameters: manifest.parameters ?? local?.parameters ?? undefined,
      form: (manifest.form as ToolManifest['form']) ?? (local?.form as ToolManifest['form']),
      result:
        (manifest.result as ToolManifest['result']) ?? (local?.result as ToolManifest['result']),
    }),
    [manifest, local],
  );

  /* 脚本合集（2.30.0）：manifest.scripts 存在 → 参数区多一个脚本选择器，
   * 表单按所选脚本切换（各自 parameters/form），执行参数 = {script, ...}。 */
  const collectionScripts = manifest.scripts?.length ? manifest.scripts : undefined;
  const [scriptId, setScriptId] = useState<string>(collectionScripts?.[0]?.id ?? '');
  const selectedScript =
    collectionScripts?.find((s) => s.id === scriptId) ?? collectionScripts?.[0];
  const scriptManifest = useMemo<ToolManifest | undefined>(
    () =>
      selectedScript
        ? {
            ...effectiveManifest,
            parameters: selectedScript.parameters,
            ...(selectedScript.form ? { form: selectedScript.form as ToolManifest['form'] } : {}),
            dangerous: Boolean(selectedScript.dangerous) || Boolean(effectiveManifest.dangerous),
            ...(selectedScript.description ? { description: selectedScript.description } : {}),
          }
        : undefined,
    [effectiveManifest, selectedScript],
  );
  /* 合集脚本定义变化（重新确认更新等）时，选中项失效则回落到首个脚本。 */
  useEffect(() => {
    if (collectionScripts?.length && !collectionScripts.some((s) => s.id === scriptId)) {
      setScriptId(collectionScripts[0].id);
    }
  }, [collectionScripts, scriptId]);

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [ackDanger, setAckDanger] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const install = useInstallTool();
  const remove = useDeleteLocalTool();
  const job = useInstallJob(jobId);
  const startRun = useStartLocalRun();
  const run = useLocalRun(runId);
  const stopRun = useStopRun();
  const logs = useRunLogs(runId, showLogs);
  const reportRun = useReportToolRun();
  /* One report per run_id, ever — refetches/StrictMode double-effects included. */
  const reportedRuns = useRef<Set<string>>(new Set());

  /* Installing a new version replaces the tool — drop stale run state. */
  useEffect(() => {
    setRunId(null);
    setRunError(null);
    setShowLogs(false);
    setConfirmRemove(false);
  }, [manifest.version, local?.installed_version]);

  /* Job done → dismiss the panel; badges flip via the invalidated tools query. */
  useEffect(() => {
    if (job.data?.state === 'installed') {
      setJobId(null);
    }
  }, [job.data?.state]);

  /* Terminal run → best-effort usage report (once per run_id; failures are
   * swallowed in the mutation) + refresh the bottom history section. */
  const runData = run.data;
  useEffect(() => {
    if (!runData || runData.status === 'preparing' || runData.status === 'running') {
      return;
    }
    if (reportedRuns.current.has(runData.run_id)) {
      return;
    }
    reportedRuns.current.add(runData.run_id);
    const started = Date.parse(runData.started_at ?? '');
    const finished = Date.parse(runData.finished_at ?? '');
    reportRun.mutate({
      tool_id: manifest.tool_id,
      tool_name: manifest.display_name,
      version: runData.version ?? local?.installed_version ?? undefined,
      status: runData.status as 'succeeded' | 'failed' | 'stopped' | 'timeout',
      duration_ms:
        Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0,
      argument_keys: Object.keys(runData.arguments ?? {}).slice(0, 16),
    });
    void queryClient.invalidateQueries({ queryKey: ['toolhost', 'runs', manifest.tool_id] });
  }, [
    runData,
    reportRun,
    manifest.tool_id,
    manifest.display_name,
    local?.installed_version,
    queryClient,
  ]);

  const distribution = manifest.execution?.distribution;
  const installBody = (): InstallRequestBody | null => {
    if (!distribution?.source) {
      return null;
    }
    const isRepoChannel = distribution.source.type === 'gitea_repo';
    const fallback = {
      ...(distribution.version ? { version: distribution.version } : {}),
      ...(distribution.package_sha256 ? { package_sha256: distribution.package_sha256 } : {}),
      ...(distribution.launcher ? { launcher: distribution.launcher } : {}),
      ...(distribution.runtime ? { runtime: distribution.runtime } : {}),
    };
    return {
      tool_id: manifest.tool_id,
      owner: distribution.source.owner,
      repo: distribution.source.repo,
      /* gitea_repo（2.30.0）：整仓 archive 通道——版本锚 = commit SHA */
      ...(isRepoChannel ? { channel: 'repo', ref: distribution.source.ref || 'main' } : {}),
      ...(status === 'update_available' && latestVersion ? { version: latestVersion } : {}),
      ...(Object.keys(fallback).length > 0 ? { fallback } : {}),
    };
  };

  const startInstall = async () => {
    setJobId(null);
    const body = installBody();
    if (!body) {
      setRunError(localize('com_toolbox_install_no_source'));
      return;
    }
    try {
      const started = await install.mutateAsync(body);
      setJobId(started.job_id);
    } catch {
      /* 403 already handled by the guard (chip reverts to pairing input). */
    }
  };

  /* Repair = reinstall the currently installed version (same owner/repo).
   * Only offered when the manifest carries distribution info — local-only
   * tools without a registered source can only be removed. */
  const startRepair = async () => {
    setJobId(null);
    const source = distribution?.source;
    if (!source) {
      setRunError(localize('com_toolbox_install_no_source'));
      return;
    }
    try {
      const started = await install.mutateAsync({
        tool_id: manifest.tool_id,
        owner: source.owner,
        repo: source.repo,
        ...(local?.installed_version ? { version: local.installed_version } : {}),
      });
      setJobId(started.job_id);
    } catch {
      /* guard handled */
    }
  };

  const runActive = run.data?.status === 'preparing' || run.data?.status === 'running';
  const runTerminalFailed =
    run.data && TERMINAL_RUN_STATES.includes(run.data.status) ? run.data : null;
  const outcome: ExecuteResult | null =
    run.data?.status === 'succeeded' && run.data.result != null
      ? {
          run_id: run.data.run_id,
          tool_id: manifest.tool_id,
          renderer: effectiveManifest.result?.renderer ?? 'json',
          result: run.data.result,
        }
      : null;

  const start = async () => {
    setRunError(null);
    setShowLogs(false);
    /* script 路由键以当前选中为准（历史恢复可能带回旧值，需剔除） */
    const rest = Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'script'));
    const runArguments = collectionScripts ? { script: selectedScript?.id, ...rest } : values;
    try {
      const started = await startRun.mutateAsync({
        toolId: manifest.tool_id,
        arguments: runArguments,
      });
      if (started.run_id) {
        setRunId(started.run_id);
      }
    } catch (error) {
      const detail = (error as { message?: string }).message ?? String(error);
      setRunError(detail);
    }
  };

  if (!isDesktopTool(manifest)) {
    return null;
  }

  /* 危险确认：合集取「所选脚本 ∪ 合集」的并集（切换脚本时跟随变化）。 */
  const dangerous = Boolean(
    scriptManifest ? scriptManifest.dangerous : effectiveManifest.dangerous,
  );
  const confirmRequired = dangerous;
  const damaged = tool.damaged === true;

  return (
    <div className="flex flex-col gap-5">
      {/* ── 安装 / 更新 / 删除 ─────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
          {localize('com_toolbox_local_manage')}
        </h3>
        {status === 'not_installed' && (
          <div className="flex items-center gap-3">
            <Button
              variant="default"
              className="flex items-center gap-1.5"
              disabled={install.isLoading}
              onClick={startInstall}
            >
              <Play className="size-3.5" aria-hidden="true" />
              {localize('com_toolbox_install')}
            </Button>
            <span className="text-xs text-text-tertiary">
              {localize('com_toolbox_local_run_hint')}
            </span>
          </div>
        )}
        {status === 'update_available' && (
          <div className="flex items-center gap-3">
            <Button
              variant="default"
              className="flex items-center gap-1.5"
              disabled={install.isLoading}
              onClick={startInstall}
            >
              <Play className="size-3.5" aria-hidden="true" />
              {latestVersion
                ? localize('com_toolbox_update_to', { version: latestVersion })
                : localize('com_toolbox_update_latest')}
            </Button>
            <span className="text-xs text-text-tertiary">
              {local?.installed_version &&
                localize('com_toolbox_badge_installed', { version: local.installed_version })}
            </span>
          </div>
        )}
        {status === 'installed' && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-text-secondary">
              <CircleSlash className="size-3.5 text-emerald-500" aria-hidden="true" />
              {local?.installed_version
                ? localize('com_toolbox_badge_installed', { version: local.installed_version })
                : localize('com_toolbox_badge_installed_plain')}
            </span>
            {confirmRemove ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-text-error">{localize('com_toolbox_remove_confirm')}</span>
                <Button
                  variant="default"
                  className="flex items-center gap-1"
                  disabled={remove.isLoading}
                  onClick={() => remove.mutate(manifest.tool_id)}
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                  {localize('com_toolbox_remove_confirm_yes')}
                </Button>
                <Button variant="default" onClick={() => setConfirmRemove(false)}>
                  {localize('com_toolbox_remove_cancel')}
                </Button>
              </span>
            ) : (
              <Button
                variant="default"
                className="flex items-center gap-1.5"
                disabled={remove.isLoading}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 className="size-3" aria-hidden="true" />
                {localize('com_toolbox_remove')}
              </Button>
            )}
          </div>
        )}
        {damaged && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{localize('com_toolbox_repair_hint')}</span>
            {distribution?.source && (
              <Button
                variant="default"
                className="flex items-center gap-1.5"
                disabled={install.isLoading}
                onClick={startRepair}
              >
                <Wrench className="size-3.5" aria-hidden="true" />
                {localize('com_toolbox_repair')}
              </Button>
            )}
          </div>
        )}
        {Boolean(install.error) && !(install.error as { status?: number } | null)?.status && (
          <p className="text-text-error text-xs" role="alert">
            {(install.error as Error | null)?.message}
          </p>
        )}
        {Boolean(remove.error) && (
          <p className="text-text-error text-xs" role="alert">
            {(remove.error as { status?: number } | null)?.status === 409
              ? localize('com_toolbox_remove_running')
              : (remove.error as Error | null)?.message}
          </p>
        )}
        <JobPanel job={jobId ? job.data : null} version={job.data?.version} />
      </section>

      {/* ── 参数 ─────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
          {localize('com_toolbox_params')}
        </h3>
        {collectionScripts && selectedScript && scriptManifest ? (
          <>
            <select
              className="config-input w-full"
              value={selectedScript.id}
              aria-label={localize('com_toolbox_script_label')}
              onChange={(event) => {
                setScriptId(event.target.value);
                setValues({});
              }}
            >
              {collectionScripts.map((script) => (
                <option key={script.id} value={script.id}>
                  {script.name}
                </option>
              ))}
            </select>
            {selectedScript.description && (
              <p className="text-xs text-text-tertiary">{selectedScript.description}</p>
            )}
            <SchemaForm
              manifest={scriptManifest}
              values={values}
              onChange={setValues}
              disabled={Boolean(runActive)}
            />
          </>
        ) : (
          <SchemaForm
            manifest={effectiveManifest}
            values={values}
            onChange={setValues}
            disabled={Boolean(runActive)}
          />
        )}
      </section>

      {confirmRequired && (
        <label className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <input
            type="checkbox"
            className="size-4 accent-amber-600"
            checked={ackDanger}
            disabled={Boolean(runActive)}
            onChange={(event) => setAckDanger(event.target.checked)}
          />
          {localize('com_toolbox_confirm_danger')}
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {status === 'installed' ? (
          <Button
            variant="default"
            className="flex items-center gap-1.5"
            disabled={
              Boolean(runActive) || startRun.isLoading || (confirmRequired && !ackDanger) || damaged
            }
            onClick={start}
          >
            <Play className="size-3.5" aria-hidden="true" />
            {runActive || startRun.isLoading
              ? localize('com_toolbox_running')
              : localize('com_toolbox_run')}
          </Button>
        ) : (
          <span className="text-xs text-text-tertiary">
            {localize('com_toolbox_run_needs_install')}
          </span>
        )}
        {runActive && (
          <>
            <Loader2 className="size-4 animate-spin text-text-tertiary" aria-hidden="true" />
            <Button
              variant="default"
              className="flex items-center gap-1.5"
              disabled={stopRun.isLoading}
              onClick={() => runId && stopRun.mutate(runId)}
            >
              <Square className="size-3" aria-hidden="true" />
              {localize('com_toolbox_stop')}
            </Button>
          </>
        )}
      </div>

      {runError && (
        <div
          role="alert"
          className="border-text-error/40 bg-text-error/10 text-text-error rounded-lg border px-3 py-2 text-sm"
        >
          <p>{runError}</p>
        </div>
      )}

      {runTerminalFailed && (
        <div
          role="alert"
          className="border-text-error/40 bg-text-error/10 text-text-error flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <p className="font-semibold">
            {localize(RUN_FAIL_KEYS[runTerminalFailed.status] ?? 'com_toolbox_run_failed')}
            {typeof runTerminalFailed.exit_code === 'number' &&
              ` (exit ${runTerminalFailed.exit_code})`}
          </p>
          {runTerminalFailed.error && <p className="text-xs">{runTerminalFailed.error}</p>}
          <button
            type="button"
            className="w-fit text-xs underline decoration-dotted"
            onClick={() => setShowLogs((open) => !open)}
          >
            {showLogs ? localize('com_toolbox_hide_logs') : localize('com_toolbox_show_logs')}
          </button>
          {showLogs && <RunLogs stdout={logs.data?.stdout} stderr={logs.data?.stderr} />}
        </div>
      )}

      {outcome && (
        <section className="flex flex-col gap-2">
          <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
            {localize('com_toolbox_result')}
            <code className="text-text-quaternary ml-2 normal-case tracking-normal">
              {outcome.run_id.slice(0, 8)}
            </code>
          </h3>
          <ResultView outcome={outcome} manifest={effectiveManifest} />
        </section>
      )}

      <RunRecords
        toolId={manifest.tool_id}
        collectionScripts={collectionScripts}
        onRestoreRun={setValues}
        renderResult={(result) => (
          <ResultView
            outcome={{
              run_id: '',
              tool_id: manifest.tool_id,
              renderer: effectiveManifest.result?.renderer ?? 'json',
              result,
            }}
            manifest={effectiveManifest}
          />
        )}
      />
    </div>
  );
}

/** Tool-page bottom section: the 20 most recent runs from the Toolhost (which
 * carries each run's arguments/result). Presentational shell is shared with
 * server tools (RunRecordsSection); Restore feeds the args back into the form. */
function RunRecords({
  toolId,
  collectionScripts,
  onRestoreRun,
  renderResult,
}: {
  toolId: string;
  /** 脚本合集（2.30.0）：历史行标注该次运行选中的脚本名。 */
  collectionScripts?: NonNullable<ToolManifest['scripts']>;
  onRestoreRun: (params: Record<string, unknown>) => void;
  renderResult?: (result: unknown) => ReactNode;
}) {
  const localize = useLocalize();
  const health = useToolhostHealth();
  const query = useRunsForTool(toolId, health.data === true);
  /* Backend keeps its full retention; only the DISPLAY is capped at 20. */
  const rows: RunRecordRow[] = (query.data?.runs ?? []).slice(0, 20).map((run) => ({
    key: run.run_id,
    status: run.status,
    created_at: run.created_at ?? '',
    duration_ms: localDurationMs(run),
    script_label: scriptName(run, collectionScripts),
    params: run.arguments ?? null,
    result: run.result,
    onRestore: run.arguments ? onRestoreRun : undefined,
  }));
  return <RunRecordsSection rows={rows} localize={localize} renderResult={renderResult} />;
}

function scriptName(run: LocalRun, scripts?: NonNullable<ToolManifest['scripts']>): string | null {
  const id = typeof run.arguments?.script === 'string' ? run.arguments.script : null;
  if (!id) {
    return null;
  }
  return scripts?.find((s) => s.id === id)?.name ?? id;
}

function localDurationMs(run: LocalRun): number | null {
  const started = Date.parse(run.started_at ?? '');
  const finished = Date.parse(run.finished_at ?? '');
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : null;
}

function JobPanel({ job, version }: { job: InstallJob | null | undefined; version?: string }) {
  const localize = useLocalize();
  if (!job || job.state === 'installed') {
    return null;
  }
  if (job.state === 'failed') {
    const key = job.error ? ERROR_KEYS[job.error.code] : undefined;
    return (
      <div
        role="alert"
        className="border-text-error/40 bg-text-error/10 text-text-error flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm"
      >
        <p className="font-semibold">{localize('com_toolbox_install_failed')}</p>
        {key && <p>{localize(key)}</p>}
        {job.error?.message && <p className="text-xs opacity-80">{job.error.message}</p>}
      </div>
    );
  }
  const stageKey = STAGE_KEYS[job.state];
  const percent = job.state === 'downloading' ? job.progress_percent : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-medium bg-surface-tertiary px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 text-text-secondary">
        <Spinner className="size-3.5" />
        <span>
          {version
            ? localize('com_toolbox_installing', { version })
            : localize('com_toolbox_install')}
          {' · '}
          {stageKey ? localize(stageKey) : job.state}
          {percent != null ? ` ${percent}%` : ''}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-border-xheavy"
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={localize('com_toolbox_install')}
      >
        <div
          className={cn(
            'h-full bg-indigo-500 transition-all',
            percent == null && 'w-full animate-pulse',
          )}
          style={percent != null ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

function RunLogs({ stdout, stderr }: { stdout?: string[]; stderr?: string[] }) {
  return (
    <div className="flex flex-col gap-2 font-mono">
      {[
        ['stdout', stdout],
        ['stderr', stderr],
      ].map(([label, lines]) => (
        <div key={label as string} className="flex flex-col gap-1">
          <span className="text-text-quaternary text-[10px] uppercase tracking-wide">
            {label as string}
          </span>
          <pre className="max-h-48 overflow-auto rounded-md border border-border-medium bg-surface-primary p-2 text-xs text-text-secondary">
            {(lines as string[] | undefined)?.length ? (lines as string[]).join('\n') : '(empty)'}
          </pre>
        </div>
      ))}
    </div>
  );
}
