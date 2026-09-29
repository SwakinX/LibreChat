import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@librechat/client';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Map as MapIcon, MonitorX, Play, Wrench, X } from 'lucide-react';
import type { ExecuteResult, ToolManifest } from './types';
import {
  isDesktopTool,
  isLocallyManagedTool,
  isPluginTool,
  isWebTool,
  type MergedTool,
} from './toolStatus';
import { RunRecordsSection, type RunRecordRow } from './RunRecordsSection';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import { executeUpload, useExecuteTool, useMyRunsForTool } from './api';
import { cacheRun, getCachedRun } from './runParamsCache';
import { useMergedTools } from './toolhostHooks';
import PluginRunner from './PluginRunner';
import LocalRunner from './LocalRunner';
import SchemaForm from './SchemaForm';
import ResultView from './ResultView';
import WebRunner from './WebRunner';
import MapPanel from './MapPanel';
import { cn } from '~/utils';

/** TerraVox Toolbox: manifest-driven tool runner (/toolbox). The sidebar's
 * ToolboxSection lists the tools; this surface runs the one in `?tool=`.
 * Desktop tools run on the user's machine via the local Toolhost (browser
 * direct); server/web tools go through the gateway execute proxy. */
export default function Toolbox() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const toolId = searchParams.get('tool');
  const { tools, online } = useMergedTools();
  const selected = useMemo(
    () => tools.find((tool) => tool.manifest.tool_id === toolId) ?? null,
    [tools, toolId],
  );
  useDocumentTitle(
    selected
      ? `${selected.manifest.display_name} · ${localize('com_toolbox_nav')}`
      : `${localize('com_toolbox_nav')} · ${user?.username ?? 'TerraVox'}`,
  );

  const isMapPanel = searchParams.get('panel') === 'map';
  const selectedIsLocal = selected != null && isLocallyManagedTool(selected.manifest);
  /* Offline hint is only actionable for locally managed tools (desktop/plugin) —
   * server/web users lose nothing when the Toolhost is down. */
  const showOfflineHint =
    !online &&
    (selectedIsLocal || (!selected && tools.some((tool) => isLocallyManagedTool(tool.manifest))));

  return (
    /* No bg class: the content pane inherits the body theme background —
     * identical to the chat page (2026-09-28 user directive). */
    <div className="flex h-full flex-col overflow-hidden text-text-primary">
      <header className="flex items-center gap-3 border-b border-border-light px-4 py-3">
        <Wrench className="size-5 shrink-0 text-text-tertiary" aria-hidden="true" />
        {/* 工具标题与信息直接放在页面标题栏：选中工具后取代静态"工具箱"标题 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold">
              {selected ? selected.manifest.display_name : localize('com_toolbox_title')}
            </h1>
            {selected?.manifest.dangerous && (
              <span className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {localize('com_toolbox_dangerous')}
              </span>
            )}
          </div>
          <span className="truncate text-xs text-text-tertiary">
            {selected ? selected.manifest.description : localize('com_toolbox_subtitle')}
          </span>
        </div>
        {selected && (
          <code className="text-text-quaternary shrink-0 text-xs">{selected.manifest.tool_id}</code>
        )}
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border-medium px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
          onClick={() =>
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set('panel', 'map');
              return next;
            })
          }
        >
          <MapIcon className="size-3.5" aria-hidden="true" />
          {localize('com_toolbox_map_open')}
        </button>
      </header>

      {isMapPanel && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <button
            type="button"
            className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border-medium px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
            onClick={() =>
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('panel');
                return next;
              })
            }
          >
            <X className="size-3.5" aria-hidden="true" />
            {localize('com_toolbox_map_close')}
          </button>
          <MapPanel className="min-h-0 w-full flex-1 rounded-lg border border-border-medium" />
        </div>
      )}
      {!isMapPanel && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {showOfflineHint && (
              <div className="flex items-center gap-2 rounded-lg border border-border-medium bg-surface-tertiary px-3 py-2 text-sm text-text-secondary">
                <MonitorX className="size-4 shrink-0" aria-hidden="true" />
                {localize('com_toolbox_toolhost_desktop_offline')}
              </div>
            )}
            <ToolBody selected={selected} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Tool surfaces by kind (contracts 2.11.0): desktop automation via the
 * Toolhost package protocol; plugins via install-script + host launch; web
 * links open in a new tab; everything else executes server-side. */
function ToolBody({ selected }: { selected: MergedTool | null }) {
  const localize = useLocalize();
  if (!selected) {
    return (
      <p className="py-16 text-center text-sm text-text-tertiary">
        {localize('com_toolbox_select_hint')}
      </p>
    );
  }
  if (isPluginTool(selected.manifest)) {
    return <PluginRunner key={selected.manifest.tool_id} tool={selected} />;
  }
  if (isWebTool(selected.manifest)) {
    return <WebRunner key={selected.manifest.tool_id} manifest={selected.manifest} />;
  }
  if (isDesktopTool(selected.manifest)) {
    return <LocalRunner key={selected.manifest.tool_id} tool={selected} />;
  }
  return <ToolRunner key={selected.manifest.tool_id} manifest={selected.manifest} />;
}

function ToolRunner({ manifest }: { manifest: ToolManifest }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [ackDanger, setAckDanger] = useState(false);
  const [outcome, setOutcome] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const execute = useExecuteTool(manifest.tool_id);

  /* Server executions land in the gateway's usage records on terminal states
   * (success/error/timeout) — refresh the bottom history section accordingly.
   * NEEDS_CONFIRMATION is a pre-run rejection with no record, so it skips. */
  const refreshMyRuns = () =>
    void queryClient.invalidateQueries({ queryKey: ['terravox', 'myruns', manifest.tool_id] });

  const run = async () => {
    setError(null);
    setOutcome(null);
    try {
      /* upload 控件工具走 multipart 通道（文件内容不进 JSON params）。 */
      const uploadNames = Object.entries(manifest.form?.fields ?? {})
        .filter(([, hint]) => hint?.widget === 'upload')
        .map(([name]) => name);
      const result = uploadNames.length
        ? await executeUpload(manifest.tool_id, {
            file: values[uploadNames[0]] as File,
            params: Object.fromEntries(
              Object.entries(values).filter(([name]) => !uploadNames.includes(name)),
            ),
            confirmed: manifest.dangerous ? ackDanger || needsConfirm : undefined,
          })
        : await execute.mutateAsync({
            params: values,
            confirmed: manifest.dangerous ? ackDanger || needsConfirm : undefined,
          });
      /* Values stay in this browser (audit trail stores key names only). */
      cacheRun(manifest.tool_id, {
        run_id: result.run_id,
        params: values,
        result: result.result,
        ts: Date.now(),
      });
      setOutcome(result);
      refreshMyRuns();
    } catch (err) {
      const e = err as Error & { code?: string; payload?: { message?: string } };
      const detailMessage = e.payload?.message ?? e.message;
      if (e.code === 'NEEDS_CONFIRMATION') {
        setNeedsConfirm(true);
        return;
      }
      setError({ code: e.code, message: detailMessage });
      refreshMyRuns();
    }
  };

  const confirmRequired = Boolean(manifest.dangerous) || needsConfirm;

  return (
    <div className="flex flex-col gap-5">
      {/* 标题/危险标记/描述已上移到页面顶部标题栏，正文直接从参数区开始 */}

      <section className="flex flex-col gap-3">
        <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
          {localize('com_toolbox_params')}
        </h3>
        <SchemaForm
          manifest={manifest}
          values={values}
          onChange={setValues}
          disabled={execute.isLoading}
        />
      </section>

      {confirmRequired && (
        <label className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <input
            type="checkbox"
            className="size-4 accent-amber-600"
            checked={ackDanger}
            disabled={execute.isLoading}
            onChange={(e) => setAckDanger(e.target.checked)}
          />
          {localize('com_toolbox_confirm_danger')}
        </label>
      )}

      <div>
        <Button
          variant="default"
          className="flex items-center gap-1.5"
          disabled={execute.isLoading || (confirmRequired && !ackDanger)}
          onClick={run}
        >
          <Play className="size-3.5" aria-hidden="true" />
          {execute.isLoading ? localize('com_toolbox_running') : localize('com_toolbox_run')}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            'rounded-lg border px-3 py-2 text-sm',
            error.code === 'TOOL_USER_ERROR'
              ? 'border-border-medium bg-surface-tertiary text-text-secondary'
              : 'border-text-error/40 bg-text-error/10 text-text-error',
          )}
        >
          {error.code === 'TOOL_USER_ERROR' && (
            <p className="mb-1 font-semibold">{localize('com_toolbox_action_needed')}</p>
          )}
          <p>{error.message}</p>
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
          <ResultView outcome={outcome} manifest={manifest} />
        </section>
      )}

      <MyRunRecords
        toolId={manifest.tool_id}
        onRestoreRun={setValues}
        renderResult={(result) => (
          <ResultView
            outcome={{
              run_id: '',
              tool_id: manifest.tool_id,
              renderer: manifest.result?.renderer ?? 'json',
              result,
            }}
            manifest={manifest}
          />
        )}
      />
    </div>
  );
}

/** Server-tool twin of LocalRunner's run-history section: rows come from the
 * gateway's usage records (own rows only); the params/result join comes from
 * this browser's cache (the gateway stores key names only). Restore feeds the
 * cached params back into the form. */
export function MyRunRecords({
  toolId,
  onRestoreRun,
  renderResult,
}: {
  toolId: string;
  onRestoreRun: (params: Record<string, unknown>) => void;
  renderResult?: (result: unknown) => ReactNode;
}) {
  const localize = useLocalize();
  const query = useMyRunsForTool(toolId);
  /* Backend keeps everything; only the DISPLAY is capped at 20. */
  const rows: RunRecordRow[] = (query.data?.runs ?? []).slice(0, 20).map((run) => {
    const cached = getCachedRun(toolId, run.id);
    return {
      key: run.id,
      status: run.status,
      created_at: run.created_at ?? '',
      duration_ms: run.duration_ms ?? null,
      params: cached?.params ?? null,
      result: cached?.result,
      onRestore: cached ? onRestoreRun : undefined,
    };
  });
  return <RunRecordsSection rows={rows} localize={localize} renderResult={renderResult} />;
}
