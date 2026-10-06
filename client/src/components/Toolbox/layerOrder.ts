/* 图层树排序纯函数：dnd-kit 拖拽结果与绘制数组的换算。
 *
 * 约定（2.22.0 前后一致）：layers 数组序 = 绘制序，base 行恒在首位；
 * 树的显示序（自上而下）= 覆盖层绘制序的倒序（表头在上 = 最上层绘制）。
 */

export type OrderedLayerKind = 'base' | 'tiled' | 'vector';

export interface OrderedLayer {
  key: string;
  kind: OrderedLayerKind;
}

/** 树的显示序（自上而下）= 覆盖层 key 按绘制数组的倒序。 */
export function displayOrderKeys(layers: OrderedLayer[]): string[] {
  return layers
    .filter((l) => l.kind !== 'base')
    .map((l) => l.key)
    .reverse();
}

/** 显示序内把 fromKey 移到 toKey 的位置；任一 key 不在序中或位置相同则原样返回。 */
export function moveInDisplayOrder(
  displayKeys: string[],
  fromKey: string,
  toKey: string,
): string[] {
  const from = displayKeys.indexOf(fromKey);
  const to = displayKeys.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) {
    return displayKeys;
  }
  const next = [...displayKeys];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 按新的显示序回写绘制数组：base 行保持原位，覆盖层按显示序倒序重排；
 * 不在显示序中的覆盖层（拖拽间隙新增等）保持在绘制底部，不丢层。 */
export function applyDisplayOrder<T extends OrderedLayer>(layers: T[], displayKeys: string[]): T[] {
  const byKey = new Map(layers.map((l) => [l.key, l]));
  const bases = layers.filter((l) => l.kind === 'base');
  const orderedOverlays = displayKeys
    .map((key) => byKey.get(key))
    .filter((l): l is T => !!l && l.kind !== 'base')
    .reverse();
  const rest = layers.filter((l) => l.kind !== 'base' && !displayKeys.includes(l.key));
  return [...bases, ...rest, ...orderedOverlays];
}
