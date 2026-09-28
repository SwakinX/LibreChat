import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, CloudOff, Loader2, ExternalLink, Unlink } from 'lucide-react';
import { useNextcloudStatus, usePollLink, useStartLink, useUnlink } from './api';
import StatusPopover from './StatusPopover';
import { useLocalize } from '~/hooks';

/** Cloud-drive account chip: Login Flow v2 connect / status / unlink. */
export default function NextcloudConnect() {
  const localize = useLocalize();
  const client = useQueryClient();
  const [linkId, setLinkId] = useState<string | null>(null);
  const { data: status } = useNextcloudStatus();
  const startLink = useStartLink();
  const unlink = useUnlink();
  const { data: poll } = usePollLink(linkId);

  useEffect(() => {
    if (poll?.status === 'linked') {
      setLinkId(null);
      client.invalidateQueries({ queryKey: ['terravox', 'nextcloud', 'status'] });
    }
  }, [poll?.status, client]);

  if (status?.linked) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border-medium bg-surface-tertiary px-3 py-1.5 text-xs text-text-secondary">
        <Cloud className="size-3.5 text-emerald-500" />
        <span>
          {localize('com_toolbox_nextcloud_linked')}
          {status.login_name ? ` · ${status.login_name}` : ''}
        </span>
        <button
          className="hover:text-text-error ml-1 flex items-center gap-1 text-text-tertiary transition-colors"
          disabled={unlink.isLoading}
          onClick={() => unlink.mutate()}
          title={localize('com_toolbox_unlink')}
        >
          <Unlink className="size-3" />
        </button>
      </div>
    );
  }

  if (linkId && poll?.status === 'pending') {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border-medium bg-surface-tertiary px-3 py-1.5 text-xs text-text-secondary">
        <Loader2 className="size-3.5 animate-spin" />
        <span>{localize('com_toolbox_nextcloud_connecting')}</span>
        <a
          href={startLink.data?.login_url}
          target="_blank"
          rel="noreferrer"
          className="ml-1 flex items-center gap-1 text-text-primary underline decoration-dotted"
        >
          <ExternalLink className="size-3" />
        </a>
      </div>
    );
  }

  const expired = poll?.status === 'expired' || poll?.status === 'failed';

  return (
    <button
      className="flex items-center gap-2 rounded-full border border-border-medium bg-surface-tertiary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-xheavy hover:text-text-primary"
      disabled={startLink.isLoading}
      onClick={async () => {
        const state = await startLink.mutateAsync();
        window.open(state.login_url, '_blank', 'noreferrer');
        setLinkId(state.link_id);
      }}
    >
      <CloudOff className="size-3.5" />
      <span>{localize('com_toolbox_connect_nextcloud')}</span>
      {expired && (
        <span className="text-text-error">{localize('com_toolbox_nextcloud_expired')}</span>
      )}
    </button>
  );
}

/** Sidebar icon-strip variant (2026-09-28): compact icon button with a
 * popover carrying connect/status/unlink — same hooks as the header chip. */
export function NextcloudConnectCompact() {
  const localize = useLocalize();
  const client = useQueryClient();
  const [linkId, setLinkId] = useState<string | null>(null);
  const { data: status } = useNextcloudStatus();
  const startLink = useStartLink();
  const unlink = useUnlink();
  const { data: poll } = usePollLink(linkId);

  useEffect(() => {
    if (poll?.status === 'linked') {
      setLinkId(null);
      client.invalidateQueries({ queryKey: ['terravox', 'nextcloud', 'status'] });
    }
  }, [poll?.status, client]);

  if (status === undefined) {
    return <span className="m-1 h-8 w-8" aria-hidden="true" />;
  }

  const linked = status.linked === true;
  const pending = linkId != null && poll?.status === 'pending';
  const expired = poll?.status === 'expired' || poll?.status === 'failed';

  let trigger: ReactNode;
  if (linked) {
    trigger = <Cloud className="size-5 text-emerald-500" aria-hidden="true" />;
  } else if (pending) {
    trigger = <Loader2 className="size-5 animate-spin text-amber-500" aria-hidden="true" />;
  } else {
    trigger = <CloudOff className="size-5 text-text-tertiary" aria-hidden="true" />;
  }

  let stateLabel: string;
  if (linked) {
    stateLabel = localize('com_toolbox_nextcloud_linked');
  } else if (pending) {
    stateLabel = localize('com_toolbox_nextcloud_connecting');
  } else {
    stateLabel = localize('com_toolbox_connect_nextcloud');
  }

  let panelBody: ReactNode;
  if (linked) {
    panelBody = (
      <button
        type="button"
        className="text-text-error w-fit underline decoration-dotted"
        disabled={unlink.isLoading}
        onClick={() => unlink.mutate()}
      >
        {localize('com_toolbox_unlink')}
      </button>
    );
  } else if (pending) {
    panelBody = (
      <a
        href={startLink.data?.login_url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 text-text-primary underline decoration-dotted"
      >
        <ExternalLink className="size-3" />
        {localize('com_toolbox_nextcloud_connecting')}
      </a>
    );
  } else {
    panelBody = (
      <button
        type="button"
        className="w-fit text-text-primary underline decoration-dotted"
        disabled={startLink.isLoading}
        onClick={async () => {
          const state = await startLink.mutateAsync();
          window.open(state.login_url, '_blank', 'noreferrer');
          setLinkId(state.link_id);
        }}
      >
        {localize('com_toolbox_connect_nextcloud')}
      </button>
    );
  }

  return (
    <StatusPopover
      label={`${localize('com_toolbox_status_nextcloud')} · ${stateLabel}`}
      trigger={trigger}
    >
      <p className="font-semibold text-text-secondary">
        {localize('com_toolbox_status_nextcloud')} · {stateLabel}
        {linked && status.login_name ? ` · ${status.login_name}` : ''}
      </p>
      {panelBody}
      {expired && (
        <span className="text-text-error">{localize('com_toolbox_nextcloud_expired')}</span>
      )}
    </StatusPopover>
  );
}
