import { applyDisplayOrder, displayOrderKeys, moveInDisplayOrder } from '../layerOrder';

/* 图层树排序换算的单测：数组序 = 绘制序（base 首位），显示序 = 覆盖层倒序。 */

const mk = (key: string, kind: 'base' | 'tiled' | 'vector' = 'vector') => ({ key, kind });

describe('layerOrder', () => {
  const layers = [mk('base', 'base'), mk('a', 'vector'), mk('b', 'tiled'), mk('c', 'vector')];

  it('displayOrderKeys: 显示序为绘制序去掉 base 后的倒序', () => {
    expect(displayOrderKeys(layers)).toEqual(['c', 'b', 'a']);
  });

  it('moveInDisplayOrder: 在显示序内移动并保持其他项不动', () => {
    const display = ['c', 'b', 'a'];
    expect(moveInDisplayOrder(display, 'a', 'c')).toEqual(['a', 'c', 'b']);
    expect(moveInDisplayOrder(display, 'c', 'b')).toEqual(['b', 'c', 'a']);
  });

  it('moveInDisplayOrder: 未知 key 或原位移动原样返回（不新建数组）', () => {
    const display = ['c', 'b', 'a'];
    expect(moveInDisplayOrder(display, 'x', 'c')).toBe(display);
    expect(moveInDisplayOrder(display, 'c', 'c')).toBe(display);
  });

  it('applyDisplayOrder: base 保持首位，覆盖层按显示序倒序回写', () => {
    const result = applyDisplayOrder(layers, ['a', 'c', 'b']);
    expect(result.map((l) => l.key)).toEqual(['base', 'b', 'c', 'a']);
  });

  it('applyDisplayOrder: 不在显示序中的覆盖层保持在绘制底部（不丢层）', () => {
    const result = applyDisplayOrder(layers, ['c', 'b']);
    expect(result.map((l) => l.key)).toEqual(['base', 'a', 'b', 'c']);
  });

  it('applyDisplayOrder: 显示序全量覆盖时为原序的镜像还原', () => {
    const display = displayOrderKeys(layers);
    const result = applyDisplayOrder(layers, display);
    expect(result.map((l) => l.key)).toEqual(layers.map((l) => l.key));
  });
});
