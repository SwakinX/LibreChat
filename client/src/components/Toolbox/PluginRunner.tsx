import { useEffect, useState } from 'react';
import { Button } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Rocket, Trash2, Wrench } from 'lucide-react';
import type { MergedTool } from './toolStatus';
import {
  useDeleteLocalTool,
  useInstallJob,
  useInstallTool,
  useOpenPluginHostDir,
  useStartLocalRun,
} from './toolhostHooks';
import { InstallJobPanel } from './LocalRunner';
import { PathPickInput } from './SchemaForm';
import { useReportToolRun } from './api';
import { MyRunRecords } from './index';
import { useLocalize } from '~/hooks';

/**
 * Plugin tool surface (contracts 2.11.0 / toolhost-local 1.4.0): the package
 * installs by executing its install script on this machine (UAC prompts are
 * confirmed by the user), the host software root is chosen at install time
 * (manual path or a probe-validated hint), and "run" launches the host
 * executable — reported as one usage row, history section at the bottom.
 */
export default function PluginRunner({ tool }: { tool: MergedTool }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { manifest, local, status, latestVersion } = tool;
  const distribution = manifest.execution?.distribution;
  const hints = distribution?.host_root_hints ?? [];

  const install = useInstallTool();
  const remove = useDeleteLocalTool();
  const startRun = useStartLocalRun();
  const openDir = useOpenPluginHostDir();
  const reportRun = useReportToolRun();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useInstallJob(jobId);
  const [hostRoot, setHostRoot] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  /** Host directory recorded by the Toolhost at install time (1.8.0) — shown
   * on the page and openable in Explorer. */
  const hostDir = local?.plugin?.host_root ?? '';

  useEffect(() => {
    setConfirmRemove(false);
    setLaunchError(null);
  }, [manifest.version, local?.installed_version]);

  /* Job done → dismiss the panel; badges flip via the invalidated tools query. */
  useEffect(() => {
    if (job.data?.state === 'installed' || job.data?.state === 'failed') {
      setJobId(null);
    }
  }, [job.data?.state]);

  const startInstall = (version?: string) => {
    setLaunchError(null);
    void install
      .mutateAsync({
        tool_id: manifest.tool_id,
        owner: distribution?.source?.owner ?? '',
        repo: distribution?.source?.repo ?? '',
        version,
        fallback: {
          version: distribution?.version,
          package_sha256: distribution?.package_sha256,
          host_launcher: distribution?.host_launcher,
          host_root_hints: distribution?.host_root_hints,
          install_script: distribution?.install_script,
          uninstall_script: distribution?.uninstall_script,
        },
        plugin: { host_root: hostRoot.trim() },
      })
      .then((started) => {
        setJobId(started.job_id);
      })
      .catch(() => undefined);
  };

  const launch = async () => {
    setLaunchError(null);
    try {
      await startRun.mutateAsync({ toolId: manifest.tool_id, arguments: {} });
      reportRun.mutate({
        tool_id: manifest.tool_id,
        tool_name: manifest.display_name,
        version: local?.installed_version ?? manifest.version,
        status: 'succeeded',
        duration_ms: 0,
        argument_keys: [],
      });
      void queryClient.invalidateQueries({
        queryKey: ['terravox', 'myruns', manifest.tool_id],
      });
    } catch (err) {
      const message = (err as Error).message;
      setLaunchError(message);
    }
  };

  const installed = status === 'installed' || status === 'update_available';

  return (
    <div className="flex flex-col gap-5">
      {!installed && (
        <section className="flex flex-col gap-3">
          <div
            role="note"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          >
            {localize('com_toolbox_plugin_install_warn')}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">
              {localize('com_toolbox_plugin_host_root')}
              <span className="text-text-error ml-0.5">*</span>
            </span>
            {/* 规范目录选择组件（与工具参数 widget=directory 同款）：文本框 +
                原生「浏览」对话框，路径选择下沉到本机 Toolhost。 */}
            <PathPickInput
              mode="directory"
              browseLabel={localize('com_toolbox_widget_browse')}
              placeholder={localize('com_toolbox_plugin_host_root_placeholder')}
              dialogTitle={localize('com_toolbox_plugin_host_root')}
              value={hostRoot}
              onChange={setHostRoot}
            />
            <span className="text-xs text-text-tertiary">
              {localize('com_toolbox_plugin_host_root_help', {
                launcher: distribution?.host_launcher ?? '',
              })}
            </span>
          </div>
          {hints.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-text-tertiary">
                {localize('com_toolbox_plugin_probe_candidates')}
              </span>
              {hints.map((hint) => (
                <button
                  key={hint}
                  type="button"
                  className="w-fit rounded-md border border-border-medium px-2 py-1 text-start text-xs text-text-secondary transition-colors hover:bg-surface-active-alt"
                  onClick={() => setHostRoot(hint)}
                >
                  {hint}
                </button>
              ))}
            </div>
          )}
          <div>
            <Button
              variant="default"
              disabled={install.isLoading || !hostRoot.trim()}
              onClick={() => startInstall()}
            >
              {localize('com_toolbox_plugin_install')}
            </Button>
          </div>
        </section>
      )}

      <InstallJobPanel job={job.data} version={latestVersion} />

      {installed && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              className="flex items-center gap-1.5"
              disabled={startRun.isLoading}
              onClick={() => void launch()}
            >
              <Rocket className="size-3.5" aria-hidden="true" />
              {localize('com_toolbox_plugin_launch')}
            </Button>
            {status === 'update_available' && (
              <Button
                variant="secondary"
                className="flex items-center gap-1.5"
                disabled={install.isLoading}
                onClick={() => startInstall(manifest.version)}
              >
                <Wrench className="size-3.5" aria-hidden="true" />
                {localize('com_toolbox_plugin_upgrade', { version: manifest.version })}
              </Button>
            )}
            <Button
              variant="destructive"
              className="flex items-center gap-1.5"
              onClick={() => {
                if (!confirmRemove) {
                  setConfirmRemove(true);
                  return;
                }
                remove.mutate(manifest.tool_id);
                setConfirmRemove(false);
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {confirmRemove
                ? localize('com_toolbox_confirm_remove')
                : localize('com_toolbox_plugin_uninstall')}
            </Button>
          </div>
          {hostDir && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <span className="truncate" title={hostDir}>
                {localize('com_toolbox_plugin_install_dir')}
                {'：'}
                {hostDir}
              </span>
              <Button
                variant="secondary"
                className="flex items-center gap-1.5"
                disabled={openDir.isLoading}
                onClick={() =>
                  openDir.mutateAsync(manifest.tool_id).catch((err: unknown) => {
                    setLaunchError((err as Error)?.message ?? String(err));
                  })
                }
              >
                <FolderOpen className="size-3.5" aria-hidden="true" />
                {localize('com_toolbox_plugin_open_dir')}
              </Button>
            </div>
          )}
          {launchError && (
            <div
              role="alert"
              className="border-text-error/40 bg-text-error/10 text-text-error rounded-lg border px-3 py-2 text-sm"
            >
              {localize('com_toolbox_plugin_launch_failed')}
              <p className="text-xs opacity-80">{launchError}</p>
            </div>
          )}
        </section>
      )}

      <MyRunRecords toolId={manifest.tool_id} />
    </div>
  );
}
