import { useState } from 'react';
import { ChevronRight, Cloud, Folder } from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogClose,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import { useCloudBrowse } from './api';
import { useLocalize } from '~/hooks';

export type CloudPick = { path: string; name: string };

type CloudPickerDialogProps = {
  open: boolean;
  /** file：选文件（聊天附件 / upload 控件）；dir：选目录。 */
  mode: 'file' | 'dir';
  /** 允许多选（聊天附件）；false = 点文件立即回填。 */
  multi?: boolean;
  onClose: () => void;
  onPick: (picked: CloudPick[]) => void;
};

/**
 * 云盘选择器（2.16.0）：浏览当前用户自己的 Nextcloud 目录（gateway
 * /nextcloud/browse 代理，凭据不出网关）。file 模式供聊天附件与 upload
 * 控件回填；dir 模式供目录参数。从用户根开始，面包屑逐级下钻。
 */
export default function CloudPickerDialog({
  open,
  mode,
  multi = false,
  onClose,
  onPick,
}: CloudPickerDialogProps) {
  const localize = useLocalize();
  const [dir, setDir] = useState('');
  const [selected, setSelected] = useState<CloudPick[]>([]);
  const [lastOpen, setLastOpen] = useState(false);
  /** 打开瞬间复位浏览位置与选择（渲染期受控复位，同 PastedTextDialog）。 */
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setDir('');
      setSelected([]);
    }
  }

  const query = useCloudBrowse(dir, open);
  const entries = query.data?.entries ?? [];
  const folders = entries.filter((e) => e.type === 'dir');
  const files = entries.filter((e) => e.type === 'file');

  const rel = (name: string) => (dir ? `${dir}/${name}` : name);
  const crumbs = dir ? dir.split('/') : [];

  const toggle = (name: string) => {
    const path = rel(name);
    setSelected((prev) =>
      prev.some((p) => p.path === path)
        ? prev.filter((p) => p.path !== path)
        : [...prev, { path, name }],
    );
  };

  const pick = (picked: CloudPick[]) => {
    onPick(picked);
    onClose();
  };

  const rowCls =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-surface-active-alt disabled:opacity-50';

  return (
    <OGDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent className="w-11/12 max-w-lg">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_toolbox_cloud_picker_title')}</OGDialogTitle>
        </OGDialogHeader>
        {/* 面包屑：根 + 逐级目录 */}
        <div className="flex flex-wrap items-center gap-0.5 text-xs text-text-secondary">
          <button type="button" className={rowCls + ' w-auto py-0.5'} onClick={() => setDir('')}>
            <Cloud className="size-3.5" aria-hidden="true" />
            {localize('com_toolbox_cloud_root')}
          </button>
          {crumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <ChevronRight className="text-text-quaternary size-3" aria-hidden="true" />
              <button
                type="button"
                className="rounded px-1 py-0.5 hover:bg-surface-active-alt"
                onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        <div className="max-h-[50vh] min-h-40 overflow-y-auto rounded-lg border border-border-medium">
          {query.isLoading && (
            <p className="p-4 text-center text-sm text-text-tertiary">
              {localize('com_toolbox_cloud_loading')}
            </p>
          )}
          {query.isError && (
            <p className="text-text-error p-4 text-center text-sm">
              {(query.error as Error).message || localize('com_toolbox_cloud_load_fail')}
            </p>
          )}
          {!query.isLoading && !query.isError && entries.length === 0 && (
            <p className="p-4 text-center text-sm text-text-tertiary">
              {localize('com_toolbox_cloud_empty')}
            </p>
          )}
          {folders.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className={rowCls}
              onClick={() => setDir(rel(entry.name))}
            >
              <Folder className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <ChevronRight className="text-text-quaternary size-3.5 shrink-0" aria-hidden="true" />
            </button>
          ))}
          {mode === 'file' &&
            files.map((entry) => {
              const picked = selected.some((p) => p.path === rel(entry.name));
              return (
                <button
                  key={entry.name}
                  type="button"
                  className={rowCls}
                  aria-pressed={picked}
                  onClick={() =>
                    multi ? toggle(entry.name) : pick([{ path: rel(entry.name), name: entry.name }])
                  }
                >
                  <span
                    className={
                      'flex size-4 shrink-0 items-center justify-center rounded border ' +
                      (picked ? 'border-indigo-500 bg-indigo-500' : 'border-border-medium')
                    }
                    aria-hidden="true"
                  >
                    {picked && <span className="size-2 rounded-sm bg-white" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="text-text-quaternary shrink-0 text-xs">
                    {Math.ceil(entry.size / 1024)} KB
                  </span>
                </button>
              );
            })}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <span className="text-xs text-text-tertiary">
            {mode === 'file' && multi && selected.length > 0
              ? localize('com_toolbox_cloud_selected', { n: selected.length })
              : ''}
          </span>
          <div className="flex gap-2">
            <OGDialogClose asChild>
              <Button variant="outline">{localize('com_ui_cancel')}</Button>
            </OGDialogClose>
            {mode === 'dir' ? (
              <Button
                variant="default"
                disabled={query.isLoading || query.isError}
                onClick={() => pick([{ path: dir, name: crumbs[crumbs.length - 1] ?? '' }])}
              >
                {localize('com_toolbox_cloud_pick_here')}
              </Button>
            ) : (
              <Button
                variant="default"
                disabled={selected.length === 0}
                onClick={() => pick(selected)}
              >
                {localize('com_toolbox_cloud_pick')}
              </Button>
            )}
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
