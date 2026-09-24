import { useMemo } from 'react';
import type { ExecuteResult, ToolManifest } from './types';
import { useLocalize } from '~/hooks';

type ResultViewProps = { outcome: ExecuteResult; manifest: ToolManifest };

/** Render an execution result by its manifest renderer (table/text/markdown/json for v1). */
export default function ResultView({ outcome, manifest }: ResultViewProps) {
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

  if (renderer === 'text' || renderer === 'markdown') {
    const text = typeof result === 'string' ? result : stringify(result);
    return <pre className="whitespace-pre-wrap break-words text-sm text-text-primary">{text}</pre>;
  }

  return (
    <pre className="overflow-x-auto rounded-lg border border-border-medium bg-surface-tertiary p-3 text-xs text-text-secondary">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
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
