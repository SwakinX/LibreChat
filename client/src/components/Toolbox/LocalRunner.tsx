import { useEffect, useMemo, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { CircleSlash, Loader2, Play, Square, Trash2 } from 'lucide-react';
import type { ExecuteResult, ToolManifest } from './types';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { MergedTool } from './toolStatus';
import type { InstallJob } from './toolhost';
import {
  useDeleteLocalTool,
  useInstallJob,
  useInstallTool,
  useLocalRun,
  useRunLogs,
  useStartLocalRun,
  useStopRun,
} from './toolhostHooks';
import { isDesktopTool } from './toolStatus';
import { useLocalize } from '~/hooks';
import SchemaForm from './SchemaForm';
import ResultView from './ResultView';
import { cn } from '~/utils';

const STAGE_KEYS: Record<string, TranslationKeys> = {
  downloading: 'com_toolbox_stage_downloading',
  verifying: 'com_toolbox_stage_verifying',
  staging: 'com_toolbox_stage_staging',
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
  internal: 'com_toolbox_err_internal',
};

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
  const { manifest, local, status, latestVersion } = tool;
  const effectiveManifest = useMemo<ToolManifest>(
    () => ({
      ...manifest,
      parameters: local?.parameters ?? manifest.parameters,
      form: (local?.form as ToolManifest['form']) ?? manifest.form,
      result: (local?.result as ToolManifest['result']) ?? manifest.result,
    }),
    [manifest, local],
  );

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

  const distribution = manifest.execution?.distribution;
  const installBody = () => {
    if (!distribution?.source) {
      return null;
    }
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
    try {
      const started = await startRun.mutateAsync({ toolId: manifest.tool_id, arguments: values });
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

  const dangerous = Boolean(effectiveManifest.dangerous);
  const confirmRequired = dangerous;

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
        <SchemaForm
          manifest={effectiveManifest}
          values={values}
          onChange={setValues}
          disabled={Boolean(runActive)}
        />
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
            disabled={Boolean(runActive) || startRun.isLoading || (confirmRequired && !ackDanger)}
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
    </div>
  );
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
