import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@supermapgis/iclient-leaflet';
import { useLocalize } from '~/hooks';
import { useMapConfig } from './api';

/**
 * Leaflet 地图面板（2.15.0，iClient 版）：底图用官方
 * L.supermap.tiledMapLayer（切图方案由 SuperMap 组件处理），服务根 URL 由
 * gateway /map/config 下发，浏览器经 nginx 同源反代 /iserver/ 访问；可选
 * GeoJSON 结果叠加（自动 fitBounds + 要素点击弹属性）。只读。
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
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.GeoJSON | null>(null);

  /* Init once, after the config arrives and the container has its size. */
  useEffect(() => {
    if (!config?.configured || !containerRef.current || mapRef.current) {
      return;
    }
    /* iServer 端 dom 服务 center=[0,-90]（服务未配中心）——无效中心用默认视野。 */
    const [cx, cy] = config.center.length ? config.center : [0, 0];
    const centerValid = Math.abs(cx) + Math.abs(cy) > 1e-6;
    /* 经纬度切图服务（CGCS2000/WGS84，如 dom EPSG:4490）必须用度单位 CRS，
     * 否则 iClient 换算出的 scale 与服务切图级别对不上，瓦片返回空白。 */
    const degreeCrs = config.epsg === 4326 || config.epsg === 4490 ? L.CRS.EPSG4326 : undefined;
    const map = L.map(containerRef.current, {
      // 默认视野：四川全省（服务未配中心/范围时兜底，2026-09-29 用户指定）
      center: centerValid ? ([cx, cy] as [number, number]) : [30.6, 104.0],
      zoom: centerValid ? config.zoom : 7,
      zoomControl: true,
      ...(degreeCrs ? { crs: degreeCrs } : {}),
    });
    /* SuperMap 官方组件：tiledMapLayer 自动处理 iServer 切图方案。 */
    const tiled = (
      L as unknown as {
        supermap: { tiledMapLayer: (url: string) => L.TileLayer };
      }
    ).supermap.tiledMapLayer(config.map_url);
    tiled.addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [config]);

  /* Result overlay: replace on every geojson change, fit to its extent. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current = null;
    }
    if (!geojson) {
      return;
    }
    const layer = L.geoJSON(geojson as never, {
      style: { color: '#6366f1', weight: 2, fillOpacity: 0.15 },
      onEachFeature: (feature, layerInstance) => {
        const props = (feature.properties ?? {}) as Record<string, unknown>;
        const text = Object.entries(props)
          .slice(0, 8)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join('<br/>');
        if (text) {
          layerInstance.bindPopup(text);
        }
      },
    }).addTo(map);
    layerRef.current = layer;
    const bounds = layer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [16, 16], maxZoom: 16 });
    }
  }, [geojson, config]);

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
    />
  );
}
