import { useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Play, Wrench } from 'lucide-react';
import type { ExecuteResult, ToolManifest } from './types';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useExecuteTool, useToolsQuery } from './api';
import NextcloudConnect from './NextcloudConnect';
import SchemaForm from './SchemaForm';
import ResultView from './ResultView';
import { cn } from '~/utils';

/** TerraVox Toolbox: manifest-driven tool runner (/toolbox). The sidebar's
 * ToolboxSection lists the tools; this surface runs the one in `?tool=`. */
export default function Toolbox() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  useDocumentTitle(`${localize('com_toolbox_nav')} · ${user?.username ?? 'TerraVox'}`);
  const [searchParams] = useSearchParams();
  const toolId = searchParams.get('tool');
  const { data: catalog } = useToolsQuery();
  const selected = useMemo(
    () => (catalog?.tools ?? []).find((t) => t.tool_id === toolId) ?? null,
    [catalog, toolId],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-primary text-text-primary">
      <header className="flex items-center gap-3 border-b border-border-light px-4 py-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {selected ? (
            <ToolRunner key={selected.tool_id} manifest={selected} />
          ) : (
            <p className="py-16 text-center text-sm text-text-tertiary">
              {localize('com_toolbox_select_hint')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolRunner({ manifest }: { manifest: ToolManifest }) {
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
