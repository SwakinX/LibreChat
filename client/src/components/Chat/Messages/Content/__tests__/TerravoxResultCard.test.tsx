/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TerravoxResultCard from '../Parts/TerravoxResultCard';
import MapPanel from '~/components/Toolbox/MapPanel';

/* 聊天内 terravox 空间结果卡（2.26.0）：输出即 gateway ExecuteResult JSON——
 * map 渲染器出 MapPanel 预览 + 地图浏览器跳转；map_directive 出共享指令卡；
 * 错误文本 / json 渲染器不出卡。输出形状取自 Mongo 实存消息（args/output
 * 均为 JSON 字符串）。 */

jest.mock('~/components/Toolbox/MapPanel', () => ({
  __esModule: true,
  default: jest.fn(() => <div data-testid="map-panel" />) as unknown,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const mockedMapPanel = MapPanel as jest.Mock;

const mapOutput = JSON.stringify({
  run_id: 'r1',
  tool_id: 'spatial.query_layer',
  renderer: 'map',
  result: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [104, 30.6] }, properties: {} },
    ],
  },
});

const directiveOutput = JSON.stringify({
  run_id: 'r2',
  tool_id: 'spatial.make_map_directive',
  renderer: 'map_directive',
  result: {
    count: 1,
    directive: {
      title: '辅助制图演示',
      layers: [{ layer: 'reg:abc:BD_BASIN_BOUNDARY_PG', name: '流域边界' }],
    },
  },
});

describe('TerravoxResultCard', () => {
  /* 跳转（window.location.href 赋值）不在 jsdom 断言：location 不可配置/
   * 不可替换；本组件可断言的行为是指令写入 sessionStorage（跳转与指令卡
   * 共用同一通道，浏览器侧由 MapBrowser 消费者保证）。 */

  it('renders a map preview with the result FeatureCollection for renderer=map', () => {
    render(
      <TerravoxResultCard args={'{"layer":"reg:abc:PG","max_features":100}'} output={mapOutput} />,
    );

    expect(screen.getByTestId('map-panel')).toBeInTheDocument();
    expect(mockedMapPanel.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        geojson: expect.objectContaining({ type: 'FeatureCollection' }),
      }),
    );
    expect(
      screen.getByRole('button', { name: 'com_toolbox_map_open_browser' }),
    ).toBeInTheDocument();
  });

  it('writes the call layer as a map directive and navigates to the map browser', () => {
    render(
      <TerravoxResultCard args={'{"layer":"reg:abc:PG","max_features":100}'} output={mapOutput} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_map_open_browser' }));
    expect(JSON.parse(sessionStorage.getItem('toolbox:map-directive') ?? 'null')).toEqual({
      layers: [{ layer: 'reg:abc:PG' }],
    });
  });

  it('renders the shared directive card for renderer=map_directive', () => {
    render(<TerravoxResultCard output={directiveOutput} />);

    expect(screen.getByText('辅助制图演示')).toBeInTheDocument();
    expect(screen.getByText('流域边界')).toBeInTheDocument();
    expect(screen.queryByTestId('map-panel')).not.toBeInTheDocument();
  });

  it('applies a directive via the shared sessionStorage channel', () => {
    render(<TerravoxResultCard output={directiveOutput} />);

    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_map_apply_directive' }));
    expect(JSON.parse(sessionStorage.getItem('toolbox:map-directive') ?? 'null')).toEqual({
      title: '辅助制图演示',
      layers: [{ layer: 'reg:abc:BD_BASIN_BOUNDARY_PG', name: '流域边界' }],
    });
  });

  it.each([
    ['error text', 'layer 必须是 reg:{绑定id}:{数据集} 或 host|服务|数据源|数据集 四段 id'],
    [
      'json renderer',
      JSON.stringify({
        run_id: 'r3',
        tool_id: 'spatial.registry_layers',
        renderer: 'json',
        result: [],
      }),
    ],
    ['non-JSON object', '{"renderer": "map"'],
    ['empty output', ''],
    ['no output', null],
  ])('renders nothing for %s', (_label, output) => {
    const { container } = render(<TerravoxResultCard output={output as string | null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
