import { useMemo, useState } from 'react';
import { CloudUpload, FileDown } from 'lucide-react';
import type { ExecuteResult, ToolManifest } from './types';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import { downloadProxyFile, saveTempToDrive } from './api';
import CloudPickerDialog from './CloudPickerDialog';
import { useLocalize } from '~/hooks';
import MapPanel from './MapPanel';

type ResultViewProps = { outcome: ExecuteResult; manifest: ToolManifest };

/** Render an execution result by its manifest renderer (table/text/markdown/json for v1). */
export default function ResultView({ outcome, manifest }: ResultViewProps) {
  const { renderer, result } = outcome;

  const rows = useMemo<Record<string, unknown>[]>(() => {
    if (Array.isArray(result)) {
      return result as Record<string, unknown>[];
    }
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { entries?: unknown }).entries)
    ) {
      return (result as { entries: Record<string, unknown>[] }).entries;
    }
    return [];
  }, [result]);

  /* 文本类结果直接下载（2.16.0 改版：不再默认写云盘） */
  const saveText = useMemo(
    () => saveTextFor(manifest, renderer, result, rows),
    [manifest, renderer, result, rows],
  );
  return (
    <div className="flex flex-col gap-2">
      {saveText !== null && (
        <DownloadButton text={saveText.text} ext={saveText.ext} toolId={manifest.tool_id} />
      )}
      <ResultBody outcome={outcome} manifest={manifest} />
    </div>
  );
}

function ResultBody({ outcome, manifest }: ResultViewProps) {
  const localize = useLocalize();
  const { renderer, result } = outcome;

  const rows = useMemo<Record<string, unknown>[]>(() => {
    if (Array.isArray(result)) {
      return result as Record<string, unknown>[];
    }
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { entries?: unknown }).entries)
    ) {
      return (result as { entries: Record<string, unknown>[] }).entries;
    }
    return [];
  }, [result]);

  if (renderer === 'table') {
    const columns =
      manifest.result?.config?.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
    return (
      <div className="overflow-x-auto rounded-lg border border-border-medium">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-medium bg-surface-tertiary">
              {columns.map((col) => (
                <th key={col} className="px-3 py-2 text-left font-semibold text-text-primary">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border-light last:border-b-0">
                {columns.map((col) => (
                  <td key={col} className="whitespace-nowrap px-3 py-2 text-text-secondary">
                    {formatCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(columns.length, 1)}
                  className="px-3 py-6 text-center text-text-tertiary"
                >
                  {localize('com_toolbox_empty_table')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (renderer === 'markdown') {
    /* Handlers return objects; the markdown convention is a `content` string
     * (a bare string result is accepted too). Anything else falls back to the
     * raw text view rather than rendering JSON as prose. */
    const content = markdownContent(result);
    if (content !== null) {
      return (
        <div className="markdown-result text-sm text-text-primary">
          <MarkdownLite content={content} codeExecution={false} />
        </div>
      );
    }
    return <pre className="whitespace-pre-wrap break-words text-sm">{stringify(result)}</pre>;
  }

  if (renderer === 'text') {
    const text = typeof result === 'string' ? result : stringify(result);
    return <pre className="whitespace-pre-wrap break-words text-sm text-text-primary">{text}</pre>;
  }

  if (renderer === 'file') {
    const links = normalizeLinks(result);
    if (links.length === 0) {
      return <p className="text-sm text-text-tertiary">{localize('com_toolbox_no_result')}</p>;
    }
    return (
      <ul className="flex flex-col gap-1.5">
        {links.map((link) => (
          <FileLink key={`${link.label}-${link.url}`} link={link} />
        ))}
      </ul>
    );
  }

  if (renderer === 'map') {
    const geojson = extractGeojson(result);
    return (
      <MapPanel geojson={geojson} className="h-96 w-full rounded-lg border border-border-medium" />
    );
  }

  if (renderer === 'link') {
    const links = normalizeLinks(result);
    if (links.length === 0) {
      return <p className="text-sm text-text-tertiary">{localize('com_toolbox_no_result')}</p>;
    }
    return (
      <ul className="flex flex-col gap-1.5">
        {links.map((link) => (
          <li key={`${link.label}-${link.url}`}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-indigo-500 underline decoration-dotted hover:text-indigo-400"
            >
              {link.label || link.url}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <pre className="overflow-x-auto rounded-lg border border-border-medium bg-surface-tertiary p-3 text-xs text-text-secondary">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}

/** map renderer payload: FeatureCollection directly, or {features|rows} wrapped. */
function extractGeojson(result: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.features)) {
      return { ...record, features: record.features };
    }
    if (Array.isArray(record.rows)) {
      return { type: 'FeatureCollection', features: [] };
    }
  }
  return result;
}

/** link renderer convention (2.11.0): {label,url} or [{label,url}]; bare
 * strings render as self-labeled links. */
function normalizeLinks(result: unknown): { label: string; url: string }[] {
  const rows = Array.isArray(result) ? result : [result];
  const links: { label: string; url: string }[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      links.push({ label: row, url: row });
    } else if (row && typeof row === 'object') {
      const record = row as { label?: unknown; url?: unknown; href?: unknown };
      let url = '';
      if (typeof record.url === 'string') {
        url = record.url;
      } else if (typeof record.href === 'string') {
        url = record.href;
      }
      if (url) {
        links.push({
          label: typeof record.label === 'string' ? record.label : url,
          url,
        });
      }
    }
  }
  return links;
}

/** Markdown renderer convention: a `content` string on the result object, or a bare string. */
function markdownContent(result: unknown): string | null {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (typeof content === 'string') {
      return content;
    }
  }
  return null;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return stringify(value);
  }
  return String(value);
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Textual download targets (2.16.0 改版): text/markdown/table/json results
 * download straight to the browser instead of being written to the drive. */
function saveTextFor(
  manifest: ToolManifest,
  renderer: string,
  result: unknown,
  rows: Record<string, unknown>[],
): { text: string; ext: string } | null {
  if (renderer === 'text') {
    return { text: typeof result === 'string' ? result : stringify(result), ext: 'txt' };
  }
  if (renderer === 'markdown') {
    const content = markdownContent(result);
    return content === null ? null : { text: content, ext: 'md' };
  }
  if (renderer === 'table') {
    const columns =
      manifest.result?.config?.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
    if (columns.length === 0) {
      return null;
    }
    const esc = (value: unknown) => `"${String(formatCell(value)).replaceAll('"', '""')}"`;
    return {
      text: [columns, ...rows.map((row) => columns.map((c) => esc(row[c])))]
        .map((cells) => cells.join(','))
        .join('\n'),
      ext: 'csv',
    };
  }
  if (renderer === 'map' || renderer === 'file' || renderer === 'link') {
    return null;
  }
  return { text: JSON.stringify(result, null, 2), ext: 'json' };
}

const stampName = (toolId: string, ext: string) =>
  `${toolId.replace(/\./g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;

/** 文本结果下载（2.16.0 改版：Blob 直接存盘，不再默认写云盘）。 */
function DownloadButton({ text, ext, toolId }: { text: string; ext: string; toolId: string }) {
  const localize = useLocalize();
  const download = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = stampName(toolId, ext);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-medium px-2.5 py-1.5 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
        onClick={download}
      >
        <FileDown className="size-3.5" aria-hidden="true" />
        {localize('com_toolbox_result_download')}
      </button>
    </div>
  );
}

/** file 结果单行：直接下载；临时产物（/files/temp/…）另有「保存到云盘」，
 * 弹目录选择器选定文件夹后由网关转存（2.16.0）。 */
function FileLink({ link }: { link: { label: string; url: string } }) {
  const localize = useLocalize();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [error, setError] = useState(false);
  const token = link.url.includes('/files/temp/')
    ? link.url.split('/files/temp/')[1].split('?')[0]
    : '';
  const saveToDrive = async (dir: string) => {
    setSaving(true);
    setError(false);
    try {
      const res = await saveTempToDrive(token, dir, link.label);
      setSavedPath(res.path);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-medium px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
        onClick={() => void downloadProxyFile(link.url, link.label)}
      >
        <FileDown className="size-4" aria-hidden="true" />
        {localize('com_toolbox_file_download')}
        {link.label && <code className="text-xs">{link.label}</code>}
      </button>
      {token && (
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-medium px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
          disabled={saving}
          onClick={() => setPickerOpen(true)}
        >
          <CloudUpload className="size-3.5" aria-hidden="true" />
          {saving ? localize('com_toolbox_cloud_saving') : localize('com_toolbox_cloud_save')}
        </button>
      )}
      {savedPath && (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          {localize('com_toolbox_cloud_saved')}: {savedPath}
        </span>
      )}
      {error && (
        <span className="text-text-error text-xs">{localize('com_toolbox_cloud_save_fail')}</span>
      )}
      {token && (
        <CloudPickerDialog
          open={pickerOpen}
          mode="dir"
          onClose={() => setPickerOpen(false)}
          onPick={(picked) => picked[0] && void saveToDrive(picked[0].path)}
        />
      )}
    </li>
  );
}
