import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { KeyRound, MonitorCheck, MonitorX } from 'lucide-react';
import { usePairingCode, useToolhostHealth } from './toolhostHooks';
import { pairingRejectedAtom } from './atoms';
import { useLocalize } from '~/hooks';

/** Real Toolhost pairing codes are long random strings — shorter input is a
 * paste miss, not a code. */
const MIN_CODE_LENGTH = 20;

const chipClass =
  'flex items-center gap-2 rounded-full border border-border-medium bg-surface-tertiary px-3 py-1.5 text-xs text-text-secondary';

/** Header chip next to the cloud-drive connect: Toolhost probe + one-time
 * pairing code entry. Offline (gray) / online unpaired (input) / paired. */
export default function ToolhostStatus() {
  const localize = useLocalize();
  const health = useToolhostHealth();
  const rejected = useAtomValue(pairingRejectedAtom);
  const { code, saveCode } = usePairingCode();
  const [draft, setDraft] = useState('');
  const [tooShort, setTooShort] = useState(false);

  /* Probe still pending on load — render nothing rather than flash "offline". */
  if (health.data === undefined) {
    return null;
  }

  if (!health.data) {
    return (
      <div className={chipClass} title={localize('com_toolbox_toolhost_offline_hint')}>
        <MonitorX className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{localize('com_toolbox_toolhost_offline')}</span>
      </div>
    );
  }

  if (!code) {
    return (
      <form
        className={chipClass}
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
        <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
        <input
          type="password"
          className="w-40 border-0 bg-transparent p-0 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
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
        {(rejected || tooShort) && (
          <span className="text-text-error shrink-0" role="alert">
            {rejected
              ? localize('com_toolbox_toolhost_pair_rejected')
              : localize('com_toolbox_toolhost_code_short')}
          </span>
        )}
      </form>
    );
  }

  return (
    <div
      className={chipClass}
      title={`${localize('com_toolbox_toolhost_paired')}${localize('com_toolbox_local_run_hint')}`}
    >
      <MonitorCheck className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
      <span>{localize('com_toolbox_toolhost_paired')}</span>
    </div>
  );
}
