import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Tool-page bottom「运行记录」section, shared by both runners: desktop tools
 * (rows from the Toolhost) and server tools (rows from the gateway's usage
 * records, contracts 2.10.0). Run count + compact newest-first rows only — no
 * detail expansion, no filters; that surface lives in the admin stats.
 */

/** Source-agnostic history row: durations are pre-computed so a Toolhost run
 * (started/finished timestamps) and a gateway report (duration_ms) render alike. */
export type RunRecordRow = {
  key: string;
  status: string;
  created_at: string;
  duration_ms: number | null;
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
}: {
  rows: RunRecordRow[];
  localize: ReturnType<typeof useLocalize>;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={localize('com_toolbox_runs_title')}>
      <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
        {localize('com_toolbox_runs_section', { count: rows.length, limit: 200 })}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-tertiary">{localize('com_toolbox_runs_empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-light">
          {rows.map((row) => (
            <RunRow key={row.key} row={row} localize={localize} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({
  row,
  localize,
}: {
  row: RunRecordRow;
  localize: ReturnType<typeof useLocalize>;
}) {
  const duration = formatDurationMs(row.duration_ms);
  return (
    <li className="flex items-center gap-2 py-1.5 text-xs text-text-secondary">
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
      <span className="min-w-0 flex-1 truncate">
        {row.created_at ? relativeTime(row.created_at, localize) : ''}
      </span>
      {duration != null && <span className="shrink-0 text-text-tertiary">{duration}</span>}
    </li>
  );
}

export function formatDurationMs(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
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
