import { useMemo, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import {
  AlertTriangle,
  ChevronLeft,
  Cloud,
  FlaskConical,
  Layers,
  Play,
  Search,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ExecuteResult, ToolManifest } from './types';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useExecuteTool, useToolsQuery } from './api';
import NextcloudConnect from './NextcloudConnect';
import SchemaForm from './SchemaForm';
import ResultView from './ResultView';
import { cn } from '~/utils';

/** Namespace → i18n key / icon for the sidebar groups; unknown namespaces fall back to the raw name. */
const GROUP_META: Record<string, { key: string; icon: LucideIcon }> = {
  nextcloud: { key: 'com_toolbox_group_nextcloud', icon: Cloud },
  spatial: { key: 'com_toolbox_group_spatial', icon: Layers },
  echo: { key: 'com_toolbox_group_echo', icon: FlaskConical },
  demo: { key: 'com_toolbox_group_demo', icon: FlaskConical },
};

const groupOf = (tool: ToolManifest): string => tool.tool_id.split('.')[0] ?? tool.tool_id;

/** TerraVox Toolbox: manifest-driven tool runner (/toolbox), PowerToys-style master-detail. */
export default function Toolbox() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  useDocumentTitle(`${localize('com_toolbox_nav')} · ${user?.username ?? 'TerraVox'}`);
  const { data: tools = [], isLoading, error } = useToolsQuery();
  const [selectedId, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const selected = useMemo(
    () => tools.find((t) => t.tool_id === selectedId) ?? null,
    [tools, selectedId],
  );

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? tools.filter((t) =>
          [t.tool_id, t.display_name, t.description].some((s) => s?.toLowerCase().includes(q)),
        )
      : tools;
    const byGroup = new Map<string, ToolManifest[]>();
    for (const tool of matched) {
      const ns = groupOf(tool);
      const list = byGroup.get(ns) ?? [];
      list.push(tool);
      byGroup.set(ns, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, search]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-primary text-text-primary">
      <header className="flex items-center gap-3 border-b border-border-medium px-4 py-3">
        <OpenSidebar />
        <Wrench className="size-5 text-text-tertiary" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-base font-semibold">{localize('com_toolbox_title')}</h1>
          <span className="truncate text-xs text-text-tertiary">
            {localize('com_toolbox_subtitle')}
          </span>
        </div>
        <div className="ml-auto">
          <NextcloudConnect />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: grouped tool list (PowerToys-style). Hidden on small screens while a tool is open. */}
        <aside
          className={cn(
            'w-full shrink-0 flex-col gap-3 overflow-y-auto border-r border-border-medium p-3 md:flex md:w-72',
            selected ? 'hidden' : 'flex',
          )}
          aria-label={localize('com_toolbox_title')}
        >
          <label className="relative flex items-center">
            <Search
              className="pointer-events-none absolute left-3 size-4 text-text-tertiary"
              aria-hidden="true"
            />
            <input
              type="search"
              className="w-full rounded-lg border border-border-medium bg-surface-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder-text-tertiary focus:border-border-xheavy focus:outline-none"
              placeholder={localize('com_toolbox_search')}
              aria-label={localize('com_toolbox_search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          {isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!!error && <ToolsError status={(error as { status?: number }).status} />}

          {!isLoading && !error && groups.length === 0 && (
            <p className="py-10 text-center text-sm text-text-tertiary">
              {localize('com_toolbox_empty')}
            </p>
          )}

          {groups.map(([ns, items]) => {
            const meta = GROUP_META[ns];
            const label = meta ? localize(meta.key as TranslationKeys) : ns;
            const GroupIcon = meta?.icon ?? Wrench;
            return (
              <section key={ns} className="flex flex-col gap-1">
                <h2 className="text-text-quaternary flex items-center gap-1.5 px-1 pb-1 text-xs font-semibold uppercase tracking-wide">
                  <GroupIcon className="size-3.5" aria-hidden="true" />
                  {label}
                </h2>
                {items.map((tool) => (
                  <button
                    key={tool.tool_id}
                    onClick={() => setSelected(tool.tool_id)}
                    aria-current={tool.tool_id === selectedId}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors',
                      tool.tool_id === selectedId
                        ? 'border-border-medium bg-surface-tertiary font-semibold'
                        : 'text-text-secondary hover:bg-surface-tertiary',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{tool.display_name}</span>
                    {tool.dangerous && (
                      <AlertTriangle
                        className="size-3.5 shrink-0 text-amber-500"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </section>
            );
          })}
        </aside>

        {/* Right: selected tool detail + run panel. Hidden on small screens until a tool is picked. */}
        <main
          className={cn(
            'min-w-0 flex-1 overflow-y-auto p-4 md:block md:p-6',
            selected ? 'block' : 'hidden',
          )}
        >
          <div className="mx-auto w-full max-w-3xl">
            {selected ? (
              <ToolRunner
                key={selected.tool_id}
                manifest={selected}
                onBack={() => setSelected(null)}
              />
            ) : (
              <p className="py-16 text-center text-sm text-text-tertiary">
                {localize('com_toolbox_select_hint')}
              </p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Load failures: 503 from the proxy means the session predates OPENID_REUSE_TOKENS — re-login fixes it. */
function ToolsError({ status }: { status?: number }) {
  const localize = useLocalize();
  return (
    <div
      role="alert"
      className="border-text-error/40 bg-text-error/10 text-text-error flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm"
    >
      <p className="font-semibold">{localize('com_toolbox_load_error')}</p>
      <p>
        {status === 503 ? localize('com_toolbox_relogin') : localize('com_toolbox_retry_later')}
      </p>
    </div>
  );
}

function ToolRunner({ manifest, onBack }: { manifest: ToolManifest; onBack: () => void }) {
  const localize = useLocalize();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [ackDanger, setAckDanger] = useState(false);
  const [outcome, setOutcome] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const execute = useExecuteTool(manifest.tool_id);

  const run = async () => {
    setError(null);
    setOutcome(null);
    try {
      const result = await execute.mutateAsync({
        params: values,
        confirmed: manifest.dangerous ? ackDanger || needsConfirm : undefined,
      });
      setOutcome(result);
    } catch (err) {
      const e = err as Error & { code?: string; payload?: { message?: string } };
      const detailMessage = e.payload?.message ?? e.message;
      if (e.code === 'NEEDS_CONFIRMATION') {
        setNeedsConfirm(true);
        return;
      }
      setError({ code: e.code, message: detailMessage });
    }
  };

  const confirmRequired = Boolean(manifest.dangerous) || needsConfirm;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-text-secondary transition-colors hover:text-text-primary md:hidden"
        >
          <ChevronLeft className="size-4" />
          {localize('com_toolbox_back')}
        </button>
        <h2 className="text-lg font-semibold">{manifest.display_name}</h2>
        {manifest.dangerous && (
          <span className="flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3" aria-hidden="true" />
            {localize('com_toolbox_dangerous')}
          </span>
        )}
        <code className="text-text-quaternary ml-auto text-xs">{manifest.tool_id}</code>
      </div>
      <p className="text-sm text-text-tertiary">{manifest.description}</p>

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
    </div>
  );
}
