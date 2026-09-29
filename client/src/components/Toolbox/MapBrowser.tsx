import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Eye, EyeOff, Link2, Maximize, Trash2, X } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import '@supermapgis/iclient-leaflet';
import {
  useChoicesFrom,
  useExecuteTool,
  useMapConfig,
  useResolveService,
  useServices,
  type ResolveResult,
  type ServiceBinding,
} from './api';
import { useLocalize } from '~/hooks';

/* @supermapgis/iclient-leaflet 无 TS 类型：官方 API 最小声明（同 MapPanel）。 */
type IClient = {
  supermap: {
    tiledMapLayer: (url: string) => L.TileLayer;
    initMap: (
      url: string,
      options?: { mapOptions?: Record<string, unknown>; layerOptions?: Record<string, unknown> },
    ) => Promise<{ map: L.Map; layer: L.TileLayer }>;
  };
};

type LayerKind = 'base' | 'tiled' | 'vector';

/** 图层状态（可持久化；矢量要素数据不入 localStorage——恢复时按 reg 重查）。 */
type MapLayer = {
  key: string;
  kind: LayerKind;
  name: string;
  /** tiled：完整地图服务 URL（…/rest/maps/<地图>）。 */
  url?: string;
  /** vector：reg:{绑定id}:{数据集} 或兼容的四段 id（临时直加）。 */
  regId?: string;
  visible: boolean;
  opacity: number;
  color: string;
};

const STORAGE_KEY = 'terravox.mapbrowser.layers.v1';
const VECTOR_COLORS = ['#6366f1', '#f97316', '#10b981', '#ef4444', '#0ea5e9', '#a855f7'];
const QUERY_MAX_FEATURES = 1000;

function loadLayers(): MapLayer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MapLayer[];
      if (Array.isArray(parsed) && parsed.some((l) => l.kind === 'base')) {
        return parsed;
      }
    }
  } catch {
    /* 损坏的持久化当作首访 */
  }
  return [
    { key: 'base', kind: 'base', name: '', visible: true, opacity: 1, color: VECTOR_COLORS[0] },
  ];
}

/**
 * 地图浏览器（?panel=map 独立面板，2.16.0）：图层树 + Leaflet 出图。
 * - 底图来自 /map/config（iClient initMap，度 CRS 回退，同 MapPanel）；
 * - 已绑定地图服务一键加为瓦片图层；数据绑定经 spatial.registry_layers
 *   列数据集，选中即走 spatial.query_layer 取 GeoJSON 出矢量图层；
 * - 粘贴 iServer REST 链接 → /services/resolve 识别临时图层（不入注册表）；
 * - 每层显隐/透明度/排序/移除，矢量层可改着色；图层配置存 localStorage。
 */
export default function MapBrowser() {
  const localize = useLocalize();
  const [, setSearchParams] = useSearchParams();
  const { data: config, isLoading } = useMapConfig();
  const { data: svcData } = useServices();
  const resolve = useResolveService();
  const queryTool = useExecuteTool('spatial.query_layer');
  const { data: regOptions } = useChoicesFrom({ tool: 'spatial.registry_layers' });

  const [layers, setLayers] = useState<MapLayer[]>(loadLayers);
  const [features, setFeatures] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState('');
  const [url, setUrl] = useState('');
  const [resolved, setResolved] = useState<ResolveResult | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const instances = useRef<Map<string, L.Layer>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const [mapReady, setMapReady] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layers));
    } catch {
      /* 存储满/隐私模式：图层仍在本会话可用 */
    }
  }, [layers]);

  /* 地图初始化：initMap 读服务切图方案（4490 自动注册），失败回退度 CRS。 */
  useEffect(() => {
    if (!config?.configured || !containerRef.current || mapRef.current) {
      return;
    }
    let cancelled = false;
    const el = containerRef.current;
    const inst = instances.current;
    const [cx, cy] = config.center.length ? config.center : [0, 0];
    const centerValid = Math.abs(cx) + Math.abs(cy) > 1e-6;
    const view = centerValid
      ? { center: [cx, cy] as [number, number], zoom: config.zoom }
      : { center: [30.6, 104.0] as [number, number], zoom: 7 };
    const iclient = (L as unknown as IClient).supermap;
    const degreeCrs = config.epsg === 4326 || config.epsg === 4490 ? L.CRS.EPSG4326 : undefined;

    const fallbackInit = () => {
      const map = L.map(el, {
        zoomControl: true,
        ...view,
        ...(degreeCrs ? { crs: degreeCrs } : {}),
      });
      baseLayerRef.current = iclient.tiledMapLayer(config.map_url).addTo(map);
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
        baseLayerRef.current = created.layer;
      } catch {
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
      baseLayerRef.current = null;
      inst.clear();
    };
  }, [config]);

  const baseLayer = layers.find((l) => l.kind === 'base');

  /* 底图显隐/透明度。 */
  useEffect(() => {
    const map = mapRef.current;
    const base = baseLayerRef.current;
    if (!map || !base || !baseLayer) {
      return;
    }
    if (baseLayer.visible) {
      if (!map.hasLayer(base)) {
        base.addTo(map);
      }
      base.setOpacity(baseLayer.opacity);
    } else if (map.hasLayer(base)) {
      map.removeLayer(base);
    }
  }, [baseLayer, mapReady]);

  /* 瓦片图层同步：增删/显隐/透明度/叠放次序（数组后者在上）。 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const inst = instances.current;
    const live = new Set(layers.map((l) => l.key));
    for (const [key, layer] of [...inst.entries()]) {
      if (!live.has(key)) {
        map.removeLayer(layer);
        inst.delete(key);
      }
    }
    layers.forEach((l, idx) => {
      if (l.kind !== 'tiled' || !l.url) {
        return;
      }
      let tile = inst.get(l.key) as L.TileLayer | undefined;
      if (!tile) {
        tile = (L as unknown as IClient).supermap.tiledMapLayer(l.url);
        inst.set(l.key, tile);
      }
      if (l.visible) {
        if (!map.hasLayer(tile)) {
          tile.addTo(map);
        }
        tile.setOpacity(l.opacity);
        tile.setZIndex(idx + 10);
      } else if (map.hasLayer(tile)) {
        map.removeLayer(tile);
      }
    });
  }, [layers, mapReady]);

  /* 矢量图层同步：有要素才建层；风格（着色/透明度）实时跟状态。 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const inst = instances.current;
    for (const l of layers) {
      if (l.kind !== 'vector') {
        continue;
      }
      const data = features[l.key];
      let geo = inst.get(l.key) as L.GeoJSON | undefined;
      if (data && !geo) {
        geo = L.geoJSON(data as never, {
          style: () => ({ color: l.color, weight: 2, fillOpacity: 0.2 }),
          onEachFeature: (feature, featureLayer) => {
            const props = (feature.properties ?? {}) as Record<string, unknown>;
            const text = Object.entries(props)
              .slice(0, 8)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join('<br/>');
            if (text) {
              featureLayer.bindPopup(text);
            }
          },
        });
        inst.set(l.key, geo);
      }
      if (!geo) {
        continue;
      }
      if (l.visible && data) {
        if (!map.hasLayer(geo)) {
          geo.addTo(map);
          const bounds = geo.getBounds();
          if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [16, 16], maxZoom: 16 });
          }
        }
        geo.setStyle({ color: l.color, opacity: l.opacity, fillOpacity: l.opacity * 0.25 });
      } else if (map.hasLayer(geo)) {
        map.removeLayer(geo);
      }
    }
  }, [layers, features, mapReady]);

  /* 恢复持久化的矢量图层：要素不在内存，按 reg 重查一次。 */
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    for (const l of layers) {
      if (l.kind === 'vector' && l.regId && !features[l.key]) {
        void fetchFeatures(l.key, l.regId, false);
      }
    }
    // 仅挂载/地图就绪时补拉一次；layers 变化由增删动作自己负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  const fetchFeatures = useCallback(
    async (key: string, regId: string, removeFromLayerOnError = true) => {
      if (inFlight.current.has(key)) {
        return;
      }
      inFlight.current.add(key);
      try {
        const outcome = await queryTool.mutateAsync({
          params: { layer: regId, max_features: QUERY_MAX_FEATURES },
        });
        const result = outcome.result as { features?: unknown };
        setFeatures((prev) => ({ ...prev, [key]: result?.features ?? [] }));
        setNotice('');
      } catch (err) {
        if (removeFromLayerOnError) {
          setLayers((prev) => prev.filter((l) => l.key !== key));
        }
        setNotice(`${localize('com_toolbox_map_load_fail')}: ${(err as Error).message}`);
      } finally {
        inFlight.current.delete(key);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const patchLayer = (key: string, patch: Partial<MapLayer>) =>
    setLayers((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const moveLayer = (key: string, dir: -1 | 1) =>
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.key === key);
      const to = idx + dir;
      if (idx < 0 || to < 1 || to >= prev.length) {
        return prev; // 底图（索引 0）恒在最低层
      }
      const next = [...prev];
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });

  const removeLayer = (key: string) => {
    setLayers((prev) => prev.filter((l) => l.key !== key));
    setFeatures((prev) => {
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  const addTiled = (name: string, serviceUrl: string) => {
    const key = `tiled:${serviceUrl}`;
    if (layers.some((l) => l.key === key)) {
      patchLayer(key, { visible: true });
      return;
    }
    setLayers((prev) => [
      ...prev,
      {
        key,
        kind: 'tiled',
        name,
        url: serviceUrl,
        visible: true,
        opacity: 1,
        color: VECTOR_COLORS[0],
      },
    ]);
  };

  const addVector = (name: string, regId: string) => {
    const key = `vec:${regId}`;
    if (layers.some((l) => l.key === key)) {
      patchLayer(key, { visible: true });
      return;
    }
    const used = layers.filter((l) => l.kind === 'vector').length;
    setLayers((prev) => [
      ...prev,
      {
        key,
        kind: 'vector',
        name,
        regId,
        visible: true,
        opacity: 1,
        color: VECTOR_COLORS[used % VECTOR_COLORS.length],
      },
    ]);
    void fetchFeatures(key, regId);
  };

  const runResolve = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    setResolved(null);
    setNotice('');
    try {
      setResolved(await resolve.mutateAsync(trimmed));
    } catch (err) {
      setNotice(`${localize('com_toolbox_map_detect_fail')}: ${(err as Error).message}`);
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void rootRef.current?.requestFullscreen();
    }
  };

  const closeBrowser = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('panel');
      return next;
    });

  const services: ServiceBinding[] = svcData?.services ?? [];
  const boundMaps = services.filter((s) => s.type === 'iserver_map' && s.status === 'available');
  const boundDatas = services.filter((s) => s.type === 'iserver_data' && s.status === 'available');
  const overlayLayers = layers.filter((l) => l.kind !== 'base');

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 gap-3 bg-inherit p-4">
      <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border-medium p-3 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{localize('com_toolbox_map_browser')}</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={localize('com_toolbox_map_fullscreen')}
              aria-label={localize('com_toolbox_map_fullscreen')}
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
              onClick={toggleFullscreen}
            >
              <Maximize className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              title={localize('com_toolbox_map_close')}
              aria-label={localize('com_toolbox_map_close')}
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
              onClick={closeBrowser}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <input
              type="text"
              className="min-w-0 flex-1 rounded-md border border-border-light bg-surface-primary px-2 py-1.5 text-xs focus:border-border-medium focus:outline-none"
              placeholder={localize('com_toolbox_map_url_ph')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void runResolve()}
            />
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-medium px-2 py-1.5 text-xs transition-colors hover:bg-surface-active-alt"
              disabled={resolve.isLoading}
              onClick={() => void runResolve()}
            >
              <Link2 className="size-3" aria-hidden="true" />
              {resolve.isLoading
                ? localize('com_toolbox_map_detecting')
                : localize('com_toolbox_map_detect')}
            </button>
          </div>
          {resolved && (
            <ResolveCard resolved={resolved} onAddMap={addTiled} onAddVector={addVector} />
          )}
        </div>

        <section className="flex flex-col gap-1">
          <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
            {localize('com_toolbox_map_bound_services')}
          </h3>
          {boundMaps.map((svc) => (
            <div key={svc.id} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate" title={`${svc.name}（地图）`}>
                {svc.name}
              </span>
              <AddButton
                label={localize('com_toolbox_map_add')}
                onClick={() =>
                  addTiled(svc.name, `${svc.base_url}/iserver/services/${svc.service_path}`)
                }
              />
            </div>
          ))}
          {regOptions?.map((option) => (
            <div key={option.value} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate" title={option.label}>
                {option.label}
              </span>
              <AddButton
                label={localize('com_toolbox_map_add')}
                onClick={() => addVector(option.label, option.value)}
              />
            </div>
          ))}
          {!boundMaps.length && !boundDatas.length && !regOptions?.length && (
            <p className="text-xs text-text-tertiary">{localize('com_toolbox_map_no_bindings')}</p>
          )}
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-1">
          <h3 className="text-text-quaternary text-xs font-semibold uppercase tracking-wide">
            {localize('com_toolbox_map_layers')}
          </h3>
          {notice && <p className="text-text-error text-xs">{notice}</p>}
          {baseLayer && (
            <LayerRow
              layer={{ ...baseLayer, name: localize('com_toolbox_map_base') }}
              onPatch={patchLayer}
            />
          )}
          {overlayLayers.length === 0 && !baseLayer ? (
            <p className="text-xs text-text-tertiary">{localize('com_toolbox_map_empty_layers')}</p>
          ) : (
            [...overlayLayers]
              .reverse()
              .map((l) => (
                <LayerRow
                  key={l.key}
                  layer={l}
                  onPatch={patchLayer}
                  onMove={moveLayer}
                  onRemove={removeLayer}
                />
              ))
          )}
        </section>
      </aside>

      <main className="relative min-h-0 min-w-0 flex-1">
        {isLoading && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-text-tertiary">
            {localize('com_toolbox_map_loading')}
          </p>
        )}
        {!isLoading && !config?.configured && (
          <p className="absolute inset-0 flex items-center justify-center rounded-lg border border-border-medium text-sm text-text-tertiary">
            {localize('com_toolbox_map_not_configured')}
          </p>
        )}
        {config?.configured && (
          <div
            ref={containerRef}
            className="absolute inset-0 rounded-lg border border-border-medium"
          />
        )}
      </main>
    </div>
  );
}

function AddButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      className="shrink-0 rounded-md border border-border-medium p-1 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
      onClick={onClick}
    >
      <Link2 className="size-3" aria-hidden="true" />
    </button>
  );
}

/** 识别结果卡：地图服务 → 加瓦片层；数据服务 → 按数据源列数据集逐个加矢量层。 */
function ResolveCard({
  resolved,
  onAddMap,
  onAddVector,
}: {
  resolved: ResolveResult;
  onAddMap: (name: string, serviceUrl: string) => void;
  onAddVector: (name: string, regId: string) => void;
}) {
  const localize = useLocalize();
  if (resolved.status !== 'available') {
    return (
      <p className="text-text-error rounded-md border border-border-medium px-2 py-1.5 text-xs">
        {resolved.detail || resolved.status}
      </p>
    );
  }
  if (resolved.type === 'iserver_map') {
    const serviceUrl = `${resolved.base}/iserver/services/${resolved.service_path}`;
    const name = resolved.draft.maps?.[0] || resolved.service_path.split('/').pop() || serviceUrl;
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border-medium px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs" title={resolved.detail}>
          {name}
        </span>
        <AddButton
          label={localize('com_toolbox_map_add')}
          onClick={() => onAddMap(name, serviceUrl)}
        />
      </div>
    );
  }
  const hostTag = resolved.base.replace(/^[a-z]+:\/\//, '');
  const service = resolved.service_path.split('/rest/data')[0];
  const datasets = resolved.draft.datasets ?? {};
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-medium px-2 py-1.5">
      {resolved.draft.datasources?.map((ds) => (
        <div key={ds}>
          <p className="text-text-quaternary text-[10px] uppercase">{ds}</p>
          {(datasets[ds] ?? []).map((name) => (
            <div key={name} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs" title={name}>
                {name}
              </span>
              <AddButton
                label={localize('com_toolbox_map_add')}
                title={name}
                onClick={() => onAddVector(name, `${hostTag}|${service}|${ds}|${name}`)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 单行图层控件：显隐 / 名称 /（矢量）着色 / 透明度 / 排序 / 移除。 */
function LayerRow({
  layer,
  onPatch,
  onMove,
  onRemove,
}: {
  layer: MapLayer;
  onPatch: (key: string, patch: Partial<MapLayer>) => void;
  onMove?: (key: string, dir: -1 | 1) => void;
  onRemove?: (key: string) => void;
}) {
  const localize = useLocalize();
  return (
    <div className="flex flex-col gap-1 border-b border-border-light py-1.5 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          title={
            layer.visible
              ? localize('com_toolbox_map_layer_hide')
              : localize('com_toolbox_map_layer_show')
          }
          aria-label={
            layer.visible
              ? localize('com_toolbox_map_layer_hide')
              : localize('com_toolbox_map_layer_show')
          }
          className="shrink-0 rounded p-0.5 text-text-secondary transition-colors hover:text-text-primary"
          onClick={() => onPatch(layer.key, { visible: !layer.visible })}
        >
          {layer.visible ? (
            <Eye className="size-3.5" aria-hidden="true" />
          ) : (
            <EyeOff className="text-text-quaternary size-3.5" aria-hidden="true" />
          )}
        </button>
        <span className="min-w-0 flex-1 truncate" title={layer.name}>
          {layer.name}
        </span>
        {layer.kind === 'vector' && (
          <input
            type="color"
            title={localize('com_toolbox_map_style')}
            aria-label={localize('com_toolbox_map_style')}
            className="size-4 shrink-0 cursor-pointer border-none bg-transparent p-0"
            value={layer.color}
            onChange={(e) => onPatch(layer.key, { color: e.target.value })}
          />
        )}
        {onMove && (
          <span className="flex shrink-0 flex-col">
            <button
              type="button"
              title={localize('com_toolbox_map_layer_up')}
              aria-label={localize('com_toolbox_map_layer_up')}
              className="text-text-quaternary rounded p-0 transition-colors hover:text-text-primary"
              onClick={() => onMove(layer.key, 1)}
            >
              <ChevronUp className="size-3" aria-hidden="true" />
            </button>
            <button
              type="button"
              title={localize('com_toolbox_map_layer_down')}
              aria-label={localize('com_toolbox_map_layer_down')}
              className="text-text-quaternary rounded p-0 transition-colors hover:text-text-primary"
              onClick={() => onMove(layer.key, -1)}
            >
              <ChevronDown className="size-3" aria-hidden="true" />
            </button>
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            title={localize('com_toolbox_map_layer_remove')}
            aria-label={localize('com_toolbox_map_layer_remove')}
            className="text-text-quaternary hover:text-text-error shrink-0 rounded p-0.5 transition-colors"
            onClick={() => onRemove(layer.key)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <input
        type="range"
        min={0.1}
        max={1}
        step={0.1}
        aria-label={`${layer.name} opacity`}
        className="h-1 w-full accent-[var(--text-primary)]"
        value={layer.opacity}
        onChange={(e) => onPatch(layer.key, { opacity: Number(e.target.value) })}
      />
    </div>
  );
}
