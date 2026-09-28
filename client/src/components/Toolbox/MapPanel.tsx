import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLocalize } from '~/hooks';
import { useMapConfig } from './api';

/**
 * Leaflet 地图面板（2.15.0）：底图 = iServer REST 栅格瓦片（nginx 同源反代
 * /iserver/，URL 模板由 gateway /map/config 下发，凭据不进前端）；可选 GeoJSON
 * 结果叠加（自动 fitBounds + 要素点击弹属性）。只读——无编辑无测量。
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
    const map = L.map(containerRef.current, {
      center: config.center as [number, number],
      zoom: config.zoom,
      zoomControl: true,
    });
    L.tileLayer(config.tile_url_template, { tileSize: 256 }).addTo(map);
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
