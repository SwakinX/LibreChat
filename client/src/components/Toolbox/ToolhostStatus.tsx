import { useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { Download, KeyRound, Loader2, MonitorCheck, MonitorX } from 'lucide-react';
import { useAutoPairing, usePairingCode, useToolhostHealth } from './toolhostHooks';
import { useToolhostReleaseInfo } from './api';
import { pairingRejectedAtom } from './atoms';
import StatusPopover from './StatusPopover';
import { useLocalize } from '~/hooks';

/** Real Toolhost pairing codes are long random strings — shorter input is a
 * paste miss, not a code. */
const MIN_CODE_LENGTH = 20;

/** Probe + pairing state for the status chip. */
function useToolhostStatusModel() {
  const health = useToolhostHealth();
  const rejected = useAtomValue(pairingRejectedAtom);
  const { code, saveCode } = usePairingCode();
  const auto = useAutoPairing(health.data === true);
  return { health, rejected, code, saveCode, auto };
}

/** Toolhost status chip (sidebar icon strip, 2026-09-28): compact icon
 * button with a popover carrying the probe/pairing flow. */
export function ToolhostStatusCompact() {
  const localize = useLocalize();
  const { health, rejected, code, saveCode, auto } = useToolhostStatusModel();
  const [draft, setDraft] = useState('');
  const [tooShort, setTooShort] = useState(false);

  /* Probe still pending — hold the row height instead of flashing "offline". */
  if (health.data === undefined) {
    return <span className="m-1 h-8 w-8" aria-hidden="true" />;
  }

  const offline = !health.data;

  let trigger: ReactNode;
  if (offline) {
    trigger = <MonitorX className="size-5 text-text-tertiary" aria-hidden="true" />;
  } else if (code) {
    trigger = <MonitorCheck className="size-5 text-emerald-500" aria-hidden="true" />;
  } else if (auto.phase === 'pairing') {
    trigger = <Loader2 className="size-5 animate-spin text-amber-500" aria-hidden="true" />;
  } else {
    trigger = <KeyRound className="size-5 text-amber-500" aria-hidden="true" />;
  }

  let stateLabel: string;
  if (offline) {
    stateLabel = localize('com_toolbox_toolhost_offline');
  } else if (code) {
    stateLabel = localize('com_toolbox_toolhost_paired');
  } else {
    stateLabel = localize('com_toolbox_toolhost_pair_prompt');
  }

  let panelBody: ReactNode;
  if (offline) {
    panelBody = (
      <div className="flex flex-col gap-2">
        <p className="text-text-tertiary">{localize('com_toolbox_toolhost_offline_hint')}</p>
        <ToolhostInstallGuide />
      </div>
    );
  } else if (code) {
    panelBody = <p className="text-text-tertiary">{localize('com_toolbox_local_run_hint')}</p>;
  } else {
    panelBody = (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = draft.trim();
          if (value.length < MIN_CODE_LENGTH) {
            setTooShort(true);
            return;
          }
          saveCode(value);
          setDraft('');
          setTooShort(false);
        }}
      >
        <div className="flex items-center gap-2">
          <input
            type="password"
            className="w-full rounded-md border border-border-medium bg-surface-primary px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
            placeholder={localize('com_toolbox_toolhost_pair_prompt')}
            aria-label={localize('com_toolbox_toolhost_pair_prompt')}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setTooShort(false);
            }}
          />
          <button
            type="submit"
            className="shrink-0 font-medium text-text-primary underline decoration-dotted"
          >
            {localize('com_toolbox_toolhost_pair_save')}
          </button>
        </div>
        {auto.phase === 'failed' && (
          <span className="text-text-error" role="alert">
            {localize('com_toolbox_pair_auto_failed')}
            {auto.reason ? `: ${auto.reason}` : ''}
            {' · '}
            <button type="button" className="underline decoration-dotted" onClick={auto.retry}>
              {localize('com_toolbox_pair_retry')}
            </button>
          </span>
        )}
        {(rejected || tooShort) && (
          <span className="text-text-error" role="alert">
            {rejected
              ? localize('com_toolbox_toolhost_pair_rejected')
              : localize('com_toolbox_toolhost_code_short')}
          </span>
        )}
      </form>
    );
  }

  return (
    <StatusPopover
      label={`${localize('com_toolbox_status_toolhost')} · ${stateLabel}`}
      trigger={trigger}
    >
      <p className="font-semibold text-text-secondary">
        {localize('com_toolbox_status_toolhost')} · {stateLabel}
      </p>
      {panelBody}
    </StatusPopover>
  );
}

export default ToolhostStatusCompact;

/** 离线安装引导卡（4b③）：发布仓版本 + 下载直链 + 三步安装说明。
 * 发布信息取自 /toolhost/release（公开分发仓 latest）；不可用时隐藏下载钮，
 * 仅保留步骤说明。 */
function ToolhostInstallGuide() {
  const localize = useLocalize();
  const { data: release } = useToolhostReleaseInfo(true);
  const version = release?.version ?? null;
  return (
    <div className="rounded-lg border border-border-medium bg-surface-secondary p-2.5">
      <p className="text-xs font-medium text-text-primary">
        {localize('com_toolbox_toolhost_install_title')}
        {version ? ` · v${version}` : ''}
      </p>
      <ol className="list-decimal space-y-0.5 ps-4 text-xs text-text-tertiary">
        <li>{localize('com_toolbox_toolhost_install_step1')}</li>
        <li>{localize('com_toolbox_toolhost_install_step2')}</li>
        <li>{localize('com_toolbox_toolhost_install_step3')}</li>
      </ol>
      {release?.download_url && (
        <a
          href={release.download_url}
          className="mt-1 flex w-fit items-center gap-1.5 rounded-md border border-border-medium px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:bg-surface-hover"
        >
          <Download className="size-3" aria-hidden="true" />
          {localize('com_toolbox_toolhost_download')}
          {release.size ? ` (${Math.max(1, Math.round(release.size / 1024 / 1024))} MB)` : ''}
        </a>
      )}
    </div>
  );
}
