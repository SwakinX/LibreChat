import { useLocalize } from '~/hooks';

export type MapDirective = {
  title?: string;
  layers?: { layer: string; name?: string }[];
  notes?: string;
};

/** 辅助制图指令卡（2.26.0）：展示模型生成的图层指令，「应用到地图」写入
 * sessionStorage 指令通道后跳地图浏览器——MapBrowser 消费即清除（2.26.0）。
 * 工具箱 ResultView 与聊天内 TerravoxResultCard 共用同一指令通道。 */
export default function MapDirectiveCard({ directive }: { directive: MapDirective }) {
  const localize = useLocalize();
  const layers = directive.layers ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-medium bg-surface-tertiary p-3">
      {directive.title && (
        <div className="text-text-default text-sm font-medium">{directive.title}</div>
      )}
      <ul className="flex flex-col gap-1 text-xs text-text-secondary">
        {layers.map((l) => (
          <li key={l.layer}>
            <span className="text-text-default">{l.name}</span>{' '}
            <span className="font-mono text-text-tertiary">{l.layer}</span>
          </li>
        ))}
      </ul>
      {directive.notes && <div className="text-xs text-text-tertiary">{directive.notes}</div>}
      <button
        type="button"
        className="cursor-pointer self-start rounded-md border border-border-light bg-surface-active-alt px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover"
        onClick={() => {
          try {
            sessionStorage.setItem('toolbox:map-directive', JSON.stringify(directive ?? {}));
          } catch {
            /* 忽略存储失败 */
          }
          window.location.href = '/toolbox?panel=map';
        }}
      >
        {localize('com_toolbox_map_apply_directive')}
      </button>
    </div>
  );
}
