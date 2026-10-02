import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useLocalize } from '~/hooks';
import { useMapConfig } from './api';

/** 结果预览的叠加配色（MapBrowser 数据层默认色系的首色）。 */
const OVERLAY_COLOR = '#6366f1';

/** 官方栅格 ZXY 模板（iclient-mapboxgl README 同款）：服务端按 prjCoordSys
 * 3857 把度坐标系底图重投影进 Mercator 网格。{z}/{x}/{y} 记号保持字面量。 */
function rasterTileTemplate(url: string): string {
  const base = url.replace(/\/+$/, '');
  const prj = encodeURIComponent(JSON.stringify({ epsgCode: 3857 }));
  return `${base}/zxyTileImage.png?prjCoordSys=${prj}&z={z}&x={x}&y={y}&width=256&height=256&transparent=true`;
}

/** GeoJSON 中出现的几何大类（空/无几何不建对应层）。 */
function geometryKinds(data: unknown): { point: boolean; line: boolean; polygon: boolean } {
  const kinds = { point: false, line: false, polygon: false };
  const fc = data as { features?: { geometry?: { type?: string } | null }[] } | null;
  for (const f of fc?.features ?? []) {
    switch (f.geometry?.type) {
      case 'Point':
      case 'MultiPoint':
        kinds.point = true;
        break;
      case 'LineString':
      case 'MultiLineString':
        kinds.line = true;
        break;
      case 'Polygon':
      case 'MultiPolygon':
        kinds.polygon = true;
        break;
      default:
        break;
    }
  }
  return kinds;
}

/** GeoJSON 要素范围（fitBounds 用）。 */
function geojsonBounds(data: unknown): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords) || coords.length === 0) {
      return;
    }
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [x, y] = coords as [number, number];
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
      return;
    }
    for (const c of coords) {
      walk(c);
    }
  };
  const fc = data as { features?: { geometry?: { coordinates?: unknown } | null }[] } | null;
  for (const f of fc?.features ?? []) {
    walk(f.geometry?.coordinates);
  }
  return w <= e && s <= n ? [w, s, e, n] : null;
}

/**
 * 地图结果面板（2.15.0；2.21.0 引擎自 Leaflet 迁至 mapbox-gl）：底图走官方
 * zxyTileImage 栅格模板（服务端重投影 3857），服务根 URL 由 gateway
 * /map/config 下发，浏览器直连 iServer 源地址；可选 GeoJSON 结果叠加（自动
 * fitBounds + 点击弹属性）。只读。
 */
export default function MapPanel({
  className,
  geojson,
}: {
  className?: string;
  geojson?: unknown;
}) {
  const localize = useLocalize();
  const { data: config, isLoading } = useMapConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const sourceRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(0);

  /* Init once, after the config arrives and the container has its size. */
  useEffect(() => {
    if (!config?.configured || !containerRef.current || mapRef.current) {
      return;
    }
    const el = containerRef.current;
    /* iServer 端 dom 服务 center=[0,-90]（服务未配中心）——无效中心用默认视野。
     * Leaflet 时代 center=[lat,lng]；mapbox 是 [lng,lat]。 */
    const [cx, cy] = config.center.length ? config.center : [0, 0];
    const centerValid = Math.abs(cx) + Math.abs(cy) > 1e-6;
    const center: [number, number] = centerValid ? [cy, cx] : [104.0, 30.6];
    const zoom = centerValid ? (config.zoom ?? 7) : 7;
    /* 底图组（2.19.0）：按序叠放（前者在下）；env 回落时为单幅。 */
    const basemapUrls = (
      config.basemaps?.length ? config.basemaps : [{ name: '', url: config.map_url }]
    )
      .map((b) => b.url)
      .filter(Boolean) as string[];

    const map = new mapboxgl.Map({
      container: el,
      style: { version: 8, sources: {}, layers: [] },
      center,
      zoom,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    /* addSource/addLayer 必须等 style load（否则 "Style is not done loading"，
     * 实测）；栅格底图与 mapReady 都挂到 load 事件上。 */
    map.on('load', () => {
      basemapUrls.forEach((url, i) => {
        const sourceId = `base:${i}`;
        map.addSource(sourceId, {
          type: 'raster',
          tiles: [rasterTileTemplate(url)],
          tileSize: 256,
          attribution: '© SuperMap iServer',
        });
        map.addLayer({ id: sourceId, type: 'raster', source: sourceId });
      });
      setMapReady((n) => n + 1);
    });
    /* 点要素弹窗：前 8 个属性。 */
    map.on('click', (e) => {
      const overlayLayers = map
        .getStyle()
        .layers?.filter((l) => l.id.startsWith('overlay:'))
        .map((l) => l.id);
      if (!overlayLayers?.length) {
        return;
      }
      const feats = map.queryRenderedFeatures(e.point, { layers: overlayLayers });
      if (!feats.length) {
        return;
      }
      const props = (feats[0].properties ?? {}) as Record<string, unknown>;
      const text = Object.entries(props)
        .slice(0, 8)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('<br/>');
      if (!text) {
        return;
      }
      new mapboxgl.Popup({ closeButton: true, maxWidth: '320px' })
        .setLngLat(e.lngLat)
        .setHTML(text)
        .addTo(map);
    });
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      sourceRef.current = null;
    };
  }, [config]);

  /* Result overlay: replace on every geojson change, fit to its extent.
   * source 常驻 setData 原地更新；图层按几何类型建一次，避免频繁摘挂。 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const sourceId = 'overlay:src';
    if (!sourceRef.current) {
      if (!geojson) {
        return;
      }
      map.addSource(sourceId, { type: 'geojson', data: geojson as never });
      const kinds = geometryKinds(geojson);
      if (kinds.point) {
        map.addLayer({
          id: 'overlay:pt',
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 5,
            'circle-color': OVERLAY_COLOR,
            'circle-stroke-color': OVERLAY_COLOR,
            'circle-stroke-width': 2,
          },
        });
      }
      if (kinds.line) {
        map.addLayer({
          id: 'overlay:ln',
          type: 'line',
          source: sourceId,
          paint: { 'line-color': OVERLAY_COLOR, 'line-width': 2 },
        });
      }
      if (kinds.polygon) {
        map.addLayer({
          id: 'overlay:pg',
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': OVERLAY_COLOR,
            'fill-opacity': 0.15,
            'fill-outline-color': OVERLAY_COLOR,
          },
        });
      }
      sourceRef.current = sourceId;
    } else {
      const src = map.getSource(sourceId);
      if (src && 'setData' in src) {
        (src as unknown as { setData: (data: unknown) => void }).setData(
          geojson ?? { type: 'FeatureCollection', features: [] },
        );
      }
    }
    if (!geojson) {
      return;
    }
    const b = geojsonBounds(geojson);
    if (b) {
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: 16, maxZoom: 16, duration: 0 },
      );
    }
  }, [geojson, mapReady]);

  if (isLoading) {
    return (
      <div className={className ?? 'h-72 w-full'}>
        <p className="text-sm text-text-tertiary">{localize('com_toolbox_map_loading')}</p>
      </div>
    );
  }
  if (!config?.configured) {
    return (
      <div
        className={
          className ?? 'h-72 w-full rounded-lg border border-border-medium bg-surface-tertiary'
        }
      >
        <p className="flex h-full items-center justify-center text-sm text-text-tertiary">
          {localize('com_toolbox_map_not_configured')}
        </p>
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      className={className ?? 'h-72 w-full rounded-lg border border-border-medium'}
      /* 同 MapBrowser：.mapboxgl-map 会覆写 position（构建序决定胜负），
       * 内联样式兜底。 */
      style={className ? undefined : { position: 'relative', width: '100%', height: '18rem' }}
    />
  );
}
