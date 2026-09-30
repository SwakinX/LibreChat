import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@supermapgis/iclient-leaflet';
import { useLocalize } from '~/hooks';
import { useMapConfig } from './api';

/* @supermapgis/iclient-leaflet 无 TS 类型：官方 API 最小声明。 */
type IClient = {
  supermap: {
    tiledMapLayer: (url: string) => L.TileLayer;
    /** 官方 initMap：从 iServer 读切图方案/投影（4490 等自动注册），建图并挂底图。 */
    initMap: (
      url: string,
      options?: { mapOptions?: Record<string, unknown>; layerOptions?: Record<string, unknown> },
    ) => Promise<{ map: L.Map; layer: L.TileLayer }>;
  };
};

/**
 * Leaflet 地图面板（2.15.0）：底图走 iClient 官方 initMap（切图方案/坐标
 * 系/瓦片原点全部从 iServer 服务读取，跨域取不到元信息时回退显式度 CRS 的
 * tiledMapLayer）；服务根 URL 由 gateway /map/config 下发，浏览器直连
 * iServer 源地址；可选 GeoJSON 结果叠加（自动 fitBounds + 要素点击弹属性）。
 * 只读。
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
  const [mapReady, setMapReady] = useState(0);

  /* Init once, after the config arrives and the container has its size. */
  useEffect(() => {
    if (!config?.configured || !containerRef.current || mapRef.current) {
      return;
    }
    let cancelled = false;
    const el = containerRef.current;
    /* iServer 端 dom 服务 center=[0,-90]（服务未配中心）——无效中心用默认视野。 */
    const [cx, cy] = config.center.length ? config.center : [0, 0];
    const centerValid = Math.abs(cx) + Math.abs(cy) > 1e-6;
    const view = centerValid
      ? { center: [cx, cy] as [number, number], zoom: config.zoom }
      : // 默认视野：四川全省（2026-09-29 用户指定；initMap 的 mapOptions 覆盖服务值）
        { center: [30.6, 104.0] as [number, number], zoom: 7 };
    const iclient = (L as unknown as IClient).supermap;

    const fallbackInit = () => {
      /* 服务元信息 XHR 被跨域拦截时的兜底：EPSG:4326/4490 经纬度切图必须用
       * 度单位 CRS，否则 iClient 换算的 scale 对不上服务切图级别，瓦片空白。 */
      const degreeCrs = config.epsg === 4326 || config.epsg === 4490 ? L.CRS.EPSG4326 : undefined;
      const map = L.map(el, {
        zoomControl: true,
        ...view,
        ...(degreeCrs ? { crs: degreeCrs } : {}),
      });
      iclient.tiledMapLayer(config.map_url).addTo(map);
      return map;
    };

    (async () => {
      let map: L.Map;
      try {
        el.id = 'map'; // initMap 以固定 id 建图
        const created = await iclient.initMap(config.map_url, {
          mapOptions: { zoomControl: true, ...view },
        });
        map = created.map;
      } catch {
        /* initMap 失败可能已在其固定容器上建了一半图，清掉标记再兜底 */
        delete (el as unknown as { _leaflet_id?: number })._leaflet_id;
        map = fallbackInit();
      }
      if (cancelled) {
        map.remove();
        return;
      }
      L.control.scale({ imperial: false }).addTo(map);
      mapRef.current = map;
      setMapReady((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
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
      /* 点要素用圆点（Leaflet 默认 marker 图标在打包环境 404） */
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, weight: 2 }),
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
    />
  );
}
