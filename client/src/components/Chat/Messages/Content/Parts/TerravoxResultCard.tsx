import { useMemo } from 'react';
import { Map as MapIcon } from 'lucide-react';
import MapDirectiveCard, { type MapDirective } from '~/components/Toolbox/MapDirectiveCard';
import MapPanel from '~/components/Toolbox/MapPanel';
import { useLocalize } from '~/hooks';

/** terravox MCP server 名（librechat.yaml mcpServers 键），调用方以此门禁。 */
export const TERRAVOX_MCP_SERVER = 'terravox';

type ParsedResult = { renderer: string; result: unknown };

/** gateway ExecuteResult 识别：terravox MCP 调用成功时输出即其 JSON
 * （{run_id, tool_id, renderer, result}，contracts gateway/v1）；错误路径
 * 输出是纯文本（"handler not registered"、参数校验文案等），首字符非 `{`
 * 即排除，JSON.parse 再兜底。 */
function parseExecuteResult(output?: string | null): ParsedResult | null {
  if (!output || output[0] !== '{') {
    return null;
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed.renderer !== 'string' || !('result' in parsed)) {
      return null;
    }
    return { renderer: parsed.renderer, result: parsed.result };
  } catch {
    return null;
  }
}

/** 调用参数里的图层 reg id（query_layer 的 `layer`），「在地图浏览器中
 * 打开」跳转时随指令写入，MapBrowser 据此挂层拉要素。 */
function parseLayerId(args?: string | Record<string, unknown>): string | undefined {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const layer = (parsed as { layer?: unknown } | null)?.layer;
    return typeof layer === 'string' && layer ? layer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 聊天消息流内的 terravox 空间结果卡（2.26.0）：通用工具卡只展示参数与
 * 原始输出，地图类结果在这里就地渲染——
 * - `renderer: 'map'`（spatial.query_layer）→ MapPanel 要素预览 +
 *   「在地图浏览器中打开」；
 * - `renderer: 'map_directive'`（spatial.make_map_directive）→ 指令卡 +
 *   「应用到地图」（与工具箱 ResultView 共用 MapDirectiveCard 指令通道）。
 * 其余输出（错误文本、json 清单等）渲染 null，工具卡保持原样。
 */
export default function TerravoxResultCard({
  args,
  output,
}: {
  args?: string | Record<string, unknown>;
  output?: string | null;
}) {
  const localize = useLocalize();
  const parsed = useMemo(() => parseExecuteResult(output), [output]);
  const layerId = useMemo(() => parseLayerId(args), [args]);

  if (!parsed) {
    return null;
  }

  if (parsed.renderer === 'map') {
    const record = parsed.result as { features?: unknown } | null;
    const geojson =
      record && typeof record === 'object' && Array.isArray(record.features) ? record : undefined;
    return (
      <div className="my-1.5 flex flex-col gap-2">
        <MapPanel
          geojson={geojson}
          className="h-80 w-full rounded-lg border border-border-medium"
        />
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 self-start rounded-md border border-border-light bg-surface-active-alt px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover"
          onClick={() => {
            if (!layerId) {
              return;
            }
            try {
              sessionStorage.setItem(
                'toolbox:map-directive',
                JSON.stringify({ layers: [{ layer: layerId }] }),
              );
            } catch {
              /* 忽略存储失败 */
            }
            window.location.href = '/toolbox?panel=map';
          }}
        >
          <MapIcon className="size-3.5" aria-hidden="true" />
          {localize('com_toolbox_map_open_browser')}
        </button>
      </div>
    );
  }

  if (parsed.renderer === 'map_directive') {
    const d = (parsed.result ?? {}) as { directive?: MapDirective };
    return (
      <div className="my-1.5">
        <MapDirectiveCard directive={d.directive ?? {}} />
      </div>
    );
  }

  return null;
}
