import { Button } from '@librechat/client';
import { ExternalLink } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ToolManifest } from './types';
import { useReportToolRun } from './api';
import { MyRunRecords } from './index';
import { useLocalize } from '~/hooks';

/**
 * Web-link tool surface (contracts 2.11.0): "run" = open the registered URL
 * in a new tab, report one usage row (best-effort), and keep the shared
 * run-history section at the bottom. No params, no result rendering.
 */
export default function WebRunner({ manifest }: { manifest: ToolManifest }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const reportRun = useReportToolRun();
  const url = manifest.execution?.url ?? '';

  const open = () => {
    if (!url) {
      return;
    }
    window.open(url, '_blank', 'noopener');
    reportRun.mutate({
      tool_id: manifest.tool_id,
      version: manifest.version,
      status: 'succeeded',
      duration_ms: 0,
      argument_keys: [],
    });
    void queryClient.invalidateQueries({ queryKey: ['terravox', 'myruns', manifest.tool_id] });
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-lg border border-border-medium bg-surface-tertiary px-4 py-4">
        <p className="text-sm text-text-secondary">{manifest.description}</p>
        {url ? (
          <code className="text-text-quaternary truncate text-xs">{url}</code>
        ) : (
          <p className="text-text-error text-xs">{localize('com_toolbox_web_no_url')}</p>
        )}
        <div>
          <Button
            variant="default"
            className="flex items-center gap-1.5"
            disabled={!url}
            onClick={open}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {localize('com_toolbox_web_open')}
          </Button>
        </div>
      </section>

      {/* Web tools take no params — there is nothing to restore. */}
      <MyRunRecords toolId={manifest.tool_id} />
    </div>
  );
}
