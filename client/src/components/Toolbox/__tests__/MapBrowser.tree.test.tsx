/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import MapBrowser from '../MapBrowser';

/* 图层树换装 dnd-kit（2.22.0）后的渲染回归：真实 dnd-kit（不桩化）+
 * ensureMapboxGL mock（jsdom 无法建图），验证图层树/把手/排序属性完整。
 * 顺序换算逻辑由 layerOrder.test.ts 单测覆盖。 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../../libs/mapboxgl', () => ({
  /* 永不 resolve：jsdom 不建图，图层树 UI 独立于地图实例 */
  ensureMapboxGL: () => new Promise(() => {}),
}));

jest.mock('librechat-data-provider', () => ({
  /* 部分替换：ProviderId 等枚举被 @librechat/client 图标注册表引用，不能整体抹掉 */
  ...jest.requireActual('librechat-data-provider'),
  request: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../api', () => ({
  useMapConfig: () => ({
    data: {
      configured: true,
      map_url: '',
      basemaps: [],
      center: [105.0, 30.6] as [number, number],
      zoom: 7,
      epsg: 4490,
    },
    isLoading: false,
  }),
  useServices: () => ({ data: { services: [] } }),
  useResolveService: () => ({ mutateAsync: jest.fn(), isLoading: false }),
  useServiceMaps: () => ({ data: { maps: [] }, isLoading: false, isError: false }),
  useExecuteTool: () => ({ mutateAsync: jest.fn(), isLoading: false }),
  useChoicesFrom: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const seedLayers = () => {
  localStorage.setItem(
    'terravox.mapbrowser.layers.v1',
    JSON.stringify([
      { key: 'base', kind: 'base', name: '', visible: true, opacity: 1, color: '#6366f1' },
      {
        key: 'vec:a',
        kind: 'vector',
        name: '图层A',
        regId: 'reg:1:a',
        visible: true,
        opacity: 1,
        color: '#6366f1',
      },
      {
        key: 'vec:b',
        kind: 'vector',
        name: '图层B',
        regId: 'reg:1:b',
        visible: true,
        opacity: 1,
        color: '#f97316',
      },
    ]),
  );
};

describe('MapBrowser layer tree (dnd-kit)', () => {
  beforeEach(() => {
    localStorage.clear();
    seedLayers();
  });

  it('renders overlay rows in display order with sortable handles', async () => {
    render(<MapBrowser />);
    /* 显示序 = 绘制序倒序：B 在上、A 在下 */
    const handles = await screen.findAllByLabelText('com_toolbox_map_drag_handle');
    expect(handles.length).toBeGreaterThanOrEqual(2);
    /* dnd-kit 把手带排序语义属性 */
    expect(handles[0].getAttribute('aria-roledescription')).toBe('sortable');
    const names = screen.getAllByText(/图层[AB]/).map((el) => el.textContent);
    expect(names.indexOf('图层B')).toBeLessThan(names.indexOf('图层A'));
    /* mock 配置未配底图 → 底图分组不渲染 */
    expect(screen.queryByText('com_toolbox_map_base')).not.toBeInTheDocument();
  });
});
