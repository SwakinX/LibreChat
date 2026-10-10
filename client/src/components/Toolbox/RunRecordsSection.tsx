import { useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Tool-page bottom「运行记录」section, shared by both runners: desktop tools
 * (rows from the Toolhost, which carries arguments/result) and server tools
 * (rows from the gateway's usage records; the params/result come from the
 * browser's local cache keyed by run_id — values never leave the machine).
 * Count (capped at 20) + newest-first rows; a row expands to show the run's
 * parameters and result with a one-click "restore params" action. No filters —
 * that surface lives in the admin stats.
 */

/** Source-agnostic history row: durations are pre-computed so a Toolhost run
 * (started/finished timestamps) and a gateway report (duration_ms) render alike. */
export type RunRecordRow = {
  key: string;
  status: string;
  created_at: string;
  duration_ms: number | null;
  /** 2.24.0：toolbox=浏览器直跑，server=人工表单执行，mcp=AI 调用。 */
  source?: string;
  /** 脚本合集（2.30.0）：该次运行选中的脚本名（行头小徽标）。 */
  script_label?: string | null;
  /** Expanded content: the run's argument values and its result payload. */
  params?: Record<string, unknown> | null;
  result?: unknown;
  /** Present only when the params can be restored into the form. */
  onRestore?: (params: Record<string, unknown>) => void;
};

/** Every run status → label for the history rows (dot carries color, the label
 * carries meaning — never color alone). */
const RUN_STATUS_KEYS: Record<string, TranslationKeys> = {
  preparing: 'com_toolbox_runs_status_preparing',
  running: 'com_toolbox_runs_status_running',
  succeeded: 'com_toolbox_runs_status_succeeded',
  failed: 'com_toolbox_runs_status_failed',
  stopped: 'com_toolbox_runs_status_stopped',
  timeout: 'com_toolbox_runs_status_timeout',
};

const RUN_STATUS_DOT: Record<string, string> = {
  preparing: 'bg-text-tertiary',
  running: 'animate-pulse bg-indigo-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-text-error',
  stopped: 'bg-amber-500',
  timeout: 'bg-amber-500',
};

export function RunRecordsSection({
  rows,
  localize,
  renderResult,
}: {
  rows: RunRecordRow[];
  localize: ReturnType<typeof useLocalize>;
  /** Render a run's result the same way the main result area does (table/
   * markdown/... by manifest renderer); falls back to pretty JSON. */
  renderResult?: (result: unknown) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={localize('com_toolbox_runs_title')}>
      <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
        {localize('com_toolbox_runs_section', { count: rows.length, limit: 20 })}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-tertiary">{localize('com_toolbox_runs_empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-light">
          {rows.map((row) => (
            <RunRow key={row.key} row={row} localize={localize} renderResult={renderResult} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({
  row,
  localize,
  renderResult,
}: {
  row: RunRecordRow;
  localize: ReturnType<typeof useLocalize>;
  renderResult?: (result: unknown) => ReactNode;
}) {
  const duration = formatDurationMs(row.duration_ms);
  const [expanded, setExpanded] = useState(false);
  const hasDetail = row.params != null || row.result != null || row.onRestore != null;
  return (
    <li className="flex flex-col py-1.5 text-xs text-text-secondary">
      <div className="flex items-center gap-2">
        {hasDetail && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={localize('com_toolbox_runs_toggle_detail')}
            className="-ml-1 cursor-pointer rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface-active-alt hover:text-text-secondary"
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        )}
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            RUN_STATUS_DOT[row.status] ?? 'bg-text-tertiary',
          )}
          aria-hidden="true"
        />
        <span className="w-12 shrink-0">
          {localize(RUN_STATUS_KEYS[row.status] ?? 'com_toolbox_runs_status_failed')}
        </span>
        {row.source === 'mcp' && (
          <span
            className="shrink-0 rounded bg-surface-active-alt px-1 py-px text-[10px] font-medium text-text-secondary"
            title={localize('com_toolbox_runs_source_ai')}
          >
            {localize('com_toolbox_runs_source_ai')}
          </span>
        )}
        {row.script_label && (
          <span
            className="shrink-0 rounded bg-surface-active-alt px-1 py-px text-[10px] font-medium text-text-secondary"
            title={row.script_label}
          >
            {row.script_label}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {row.created_at ? relativeTime(row.created_at, localize) : ''}
        </span>
        {duration != null && <span className="shrink-0 text-text-tertiary">{duration}</span>}
      </div>
      {expanded && hasDetail && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border-light bg-surface-tertiary px-3 py-2">
          <RunDetail row={row} localize={localize} renderResult={renderResult} />
        </div>
      )}
    </li>
  );
}

function RunDetail({
  row,
  localize,
  renderResult,
}: {
  renderResult?: (result: unknown) => ReactNode;
  row: RunRecordRow;
  localize: ReturnType<typeof useLocalize>;
}) {
  const params = row.params ?? {};
  const paramEntries = Object.entries(params);
  const resultText = renderResult ? null : stringifyResult(row.result);
  return (
    <>
      <div>
        <p className="mb-1 font-medium text-text-tertiary">{localize('com_toolbox_runs_params')}</p>
        {paramEntries.length === 0 ? (
          <p className="text-text-tertiary">{localize('com_toolbox_runs_params_empty')}</p>
        ) : (
          <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1 break-all">
            {paramEntries.map(([key, val]) => (
              <div key={key} className="col-span-2 grid grid-cols-subgrid">
                <dt className="font-mono text-text-tertiary">{key}</dt>
                <dd className="min-w-0 font-mono">{formatValue(val)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {(resultText != null || (renderResult && row.result != null)) && (
        <div>
          <p className="mb-1 font-medium text-text-tertiary">
            {localize('com_toolbox_runs_result')}
          </p>
          {renderResult ? (
            renderResult(row.result)
          ) : (
            <pre className="max-h-40 overflow-auto rounded border border-border-light bg-surface-primary p-2 font-mono text-[11px] text-text-secondary">
              {resultText}
            </pre>
          )}
        </div>
      )}
      {row.onRestore && paramEntries.length > 0 && (
        <button
          type="button"
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border-medium px-2 py-1 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
          onClick={() => row.onRestore?.(params)}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {localize('com_toolbox_runs_restore')}
        </button>
      )}
    </>
  );
}

export function formatDurationMs(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function stringifyResult(result: unknown): string | null {
  if (result == null) {
    return null;
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

function relativeTime(iso: string, localize: ReturnType<typeof useLocalize>): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) {
    return localize('com_toolbox_runs_just_now');
  }
  if (minutes < 60) {
    return localize('com_toolbox_runs_minutes_ago', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return localize('com_toolbox_runs_hours_ago', { count: hours });
  }
  return localize('com_toolbox_runs_days_ago', { count: Math.floor(hours / 24) });
}
