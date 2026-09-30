import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import {
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FolderSearch,
  GripVertical,
  Layers,
  Link2,
  Maximize,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
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

/** 添加图层弹窗里的服务条目（注册表绑定按绑定 id 聚合出的数据服务）。 */
type DataService = {
  bindingId: string;
  label: string;
  datasets: { name: string; regId: string }[];
};
type MapServiceEntry = { kind: 'map'; label: string; url: string };
type AddTarget = { kind: 'data'; entry: DataService } | MapServiceEntry;

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

function mapBbox(map: L.Map): [number, number, number, number] {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

/**
 * 地图浏览器（?panel=map 独立面板，2.16.0）：GIS 风格图层树 + Leaflet 出图。
 * - 左侧「图层」树：拖拽把手改叠放次序（数组序 = 绘制序，后者在上），底图
 *   固定最底层不参与排序；点行内嵌展开控制（透明度/着色/缩放到图层/重查/移除）；
 * - 右上角 +：二级菜单「添加图层」（先选注册的服务、再选数据集/地图）与
 *   「添加 REST 服务」（粘贴 iServer 链接识别临时图层）；
 * - 刷新按钮：按当前地图范围重查全部矢量图层；
 * - 打开后工具箱标题栏切换为地图浏览器（见 Toolbox/index.tsx）。
 */
export default function MapBrowser() {
  const localize = useLocalize();
  const { data: config, isLoading } = useMapConfig();
  const { data: svcData } = useServices();
  const resolve = useResolveService();
  const queryTool = useExecuteTool('spatial.query_layer');
  const { data: regOptions } = useChoicesFrom({ tool: 'spatial.registry_layers' });

  const [layers, setLayers] = useState<MapLayer[]>(loadLayers);
  const [features, setFeatures] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  /** 图层右键菜单（框架化：项见 layerContextItems，后续加操作直接追加）。 */
  const [ctxMenu, setCtxMenu] = useState<{ key: string; x: number; y: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const instances = useRef<Map<string, L.Layer>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const fitted = useRef<Set<string>>(new Set());
  const [mapReady, setMapReady] = useState(0);
  /* 行把手 Pointer 拖拽（不用 HTML5 DnD：拖影/命中受全局样式与浏览器差异影响）：
   * 把手上按下即捕获指针，移动中命中哪行就交换到哪行，抬起结束。 */
  const dragKeyRef = useRef<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

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
    const fittedSet = fitted.current;
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
      fittedSet.clear();
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

  /* 矢量图层同步：有要素才建层；风格（着色/透明度）实时跟状态。
   * 首次挂载自动 fitBounds，之后刷新重查保持当前视野（fitted 集合）。 */
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
          /* 点要素用圆点（Leaflet 默认 marker 图标在打包环境 404，也更适合叠加） */
          pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, weight: 2 }),
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
          if (!fitted.current.has(l.key)) {
            const bounds = geo.getBounds();
            if (bounds.isValid()) {
              map.fitBounds(bounds, { padding: [16, 16], maxZoom: 16 });
            }
            fitted.current.add(l.key);
          }
        }
        geo.setStyle({ color: l.color, opacity: l.opacity, fillOpacity: l.opacity * 0.25 });
      } else if (map.hasLayer(geo)) {
        map.removeLayer(geo);
      }
    }
  }, [layers, features, mapReady]);

  /* 叠放次序同步（图层树拖拽）：数组序 = 绘制序（数组末 = 树顶 = 地图最上层）。
   * 矢量层按添加次序绘制（setZIndex 不作用于 SVG），顺序/显隐变化时按数组序
   * 统一重挂一次；透明度/颜色调整不改 stamp，不触发。 */
  const orderStampRef = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const stamp = layers.map((l) => `${l.key}:${l.visible ? 1 : 0}`).join('|');
    if (stamp === orderStampRef.current) {
      return;
    }
    orderStampRef.current = stamp;
    const inst = instances.current;
    for (const l of layers) {
      if (l.kind === 'vector') {
        const geo = inst.get(l.key);
        if (geo && map.hasLayer(geo)) {
          map.removeLayer(geo);
        }
      }
    }
    for (const l of layers) {
      if (l.kind === 'vector' && l.visible) {
        const geo = inst.get(l.key);
        if (geo && features[l.key] && !map.hasLayer(geo)) {
          geo.addTo(map);
        }
      }
    }
  }, [layers, features, mapReady]);

  const fetchFeatures = useCallback(
    async (
      key: string,
      regId: string,
      removeFromLayerOnError = true,
      bbox?: [number, number, number, number],
    ) => {
      if (inFlight.current.has(key)) {
        return;
      }
      inFlight.current.add(key);
      try {
        /* 数据更新需重建 GeoJSON 实例（风格回调捕获旧数据无妨，实例整体换新） */
        /* 数据更新需重建 GeoJSON 实例（风格回调捕获旧数据无妨，实例整体换新）；
         * 旧实例必须同时从地图摘除，否则重查后新旧两层叠加渲染 */
        const stale = instances.current.get(key);
        if (stale && mapRef.current?.hasLayer(stale)) {
          mapRef.current.removeLayer(stale);
        }
        instances.current.delete(key);
        const outcome = await queryTool.mutateAsync({
          params: { layer: regId, max_features: QUERY_MAX_FEATURES, ...(bbox ? { bbox } : {}) },
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

  const patchLayer = (key: string, patch: Partial<MapLayer>) =>
    setLayers((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /* 拖拽重排（数组序 = 绘制序，底图恒在索引 0 不参与）。 */
  const reorder = (fromKey: string, toKey: string) => {
    setLayers((prev) => {
      const from = prev.findIndex((l) => l.key === fromKey);
      const to = prev.findIndex((l) => l.key === toKey);
      if (from < 1 || to < 1 || from === to) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const beginDrag = (e: ReactPointerEvent<HTMLSpanElement>, key: string) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const row = (e.currentTarget as HTMLElement).closest('[data-layer-row]');
    try {
      row?.setPointerCapture(e.pointerId);
    } catch {
      /* 指针未激活（合成事件等）：不捕获也能拖，只是移出行后丢事件 */
    }
    dragKeyRef.current = key;
    setDraggingKey(key);
  };

  const onDragPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const key = dragKeyRef.current;
    if (!key) {
      return;
    }
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-layer-row]');
    const target = hit?.dataset.layerRow;
    if (target && target !== key) {
      reorder(key, target);
    }
  };

  const endDrag = () => {
    dragKeyRef.current = null;
    setDraggingKey(null);
  };

  const removeLayer = (key: string) => {
    setLayers((prev) => prev.filter((l) => l.key !== key));
    setFeatures((prev) => {
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    fitted.current.delete(key);
    if (selectedKey === key) {
      setSelectedKey(null);
    }
  };

  const addTiled = (name: string, serviceUrl: string) => {
    const key = `tiled:${serviceUrl}`;
    if (layers.some((l) => l.key === key)) {
      patchLayer(key, { visible: true });
      setSelectedKey(key);
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
    setSelectedKey(key);
  };

  const addVector = (name: string, regId: string) => {
    const key = `vec:${regId}`;
    if (layers.some((l) => l.key === key)) {
      patchLayer(key, { visible: true });
      setSelectedKey(key);
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
    setSelectedKey(key);
    void fetchFeatures(key, regId);
  };

  /** 刷新（图层树按钮）：矢量层按当前地图范围重查，瓦片层强制重取。 */
  const refreshLayers = () => {
    const map = mapRef.current;
    const bbox = map ? mapBbox(map) : undefined;
    for (const l of layers) {
      if (l.kind === 'vector' && l.regId) {
        void fetchFeatures(l.key, l.regId, false, bbox);
      } else if (l.kind === 'tiled') {
        (instances.current.get(l.key) as L.TileLayer | undefined)?.redraw();
      }
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void rootRef.current?.requestFullscreen();
    }
  };

  /* 添加图层弹窗数据：注册表选项按绑定 id 聚合成数据服务。 */
  const dataServices = useMemo<DataService[]>(() => {
    const byBinding = new Map<string, DataService>();
    for (const option of regOptions ?? []) {
      const match = /^reg:([^:]+):(.+)$/.exec(option.value);
      if (!match) {
        continue;
      }
      const bindingId = match[1];
      const dataset = match[2];
      const label = option.label.split(' · ')[0] || bindingId;
      const entry = byBinding.get(bindingId) ?? { bindingId, label, datasets: [] };
      entry.datasets.push({ name: dataset, regId: option.value });
      byBinding.set(bindingId, entry);
    }
    return [...byBinding.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [regOptions]);

  const services: ServiceBinding[] = svcData?.services ?? [];
  const boundMaps: MapServiceEntry[] = services
    .filter((s) => s.type === 'iserver_map' && s.status === 'available')
    .map((s) => ({
      kind: 'map' as const,
      label: s.name,
      url: `${s.base_url}/iserver/services/${s.service_path}`,
    }));

  /** 图层右键菜单项（可扩展框架：需要新操作就在数组里追加一项）。 */
  const layerContextItems = (l: MapLayer) => [
    ...(l.kind === 'vector'
      ? [
          {
            key: 'fit',
            label: localize('com_toolbox_map_fit'),
            icon: <Crosshair className="size-3.5" aria-hidden="true" />,
            danger: false,
            onClick: () => {
              fitLayer(l);
              setCtxMenu(null);
            },
          },
        ]
      : []),
    {
      key: 'props',
      label: localize('com_toolbox_map_properties'),
      icon: <Settings2 className="size-3.5" aria-hidden="true" />,
      danger: false,
      onClick: () => {
        setSelectedKey(l.key);
        setCtxMenu(null);
      },
    },
    ...(l.kind !== 'base'
      ? [
          {
            key: 'remove',
            label: localize('com_toolbox_map_layer_remove'),
            icon: <Trash2 className="size-3.5" aria-hidden="true" />,
            danger: true,
            onClick: () => {
              removeLayer(l.key);
              setCtxMenu(null);
            },
          },
        ]
      : []),
  ];

  const selectedLayer = layers.find((l) => l.key === selectedKey) ?? null;
  const overlayLayers = layers.filter((l) => l.kind !== 'base');
  /** 缩放到图层：矢量按要素范围 fitBounds（行内展开控制）。 */
  const fitLayer = (l: MapLayer) => {
    const map = mapRef.current;
    if (!map || l.kind !== 'vector') {
      return;
    }
    const geo = instances.current.get(l.key) as L.GeoJSON | undefined;
    if (geo) {
      const bounds = geo.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [16, 16], maxZoom: 16 });
      }
    }
  };
  /** 按当前地图范围重查该矢量图层。 */
  const refreshLayer = (l: MapLayer) => {
    const map = mapRef.current;
    if (!l.regId) {
      return;
    }
    void fetchFeatures(l.key, l.regId, false, map ? mapBbox(map) : undefined);
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 gap-3 bg-inherit p-4">
      {/* ── 图层树面板 ─────────────────────────────────────────── */}
      <aside className="flex w-64 shrink-0 flex-col rounded-lg border border-border-medium text-sm">
        <div className="flex items-center gap-1 border-b border-border-light px-3 py-2">
          <Layers className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 font-semibold">{localize('com_toolbox_map_layers')}</h2>
          <button
            type="button"
            title={localize('com_toolbox_map_refresh')}
            aria-label={localize('com_toolbox_map_refresh')}
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
            onClick={refreshLayers}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </button>
          <div className="relative">
            <button
              type="button"
              title={localize('com_toolbox_map_add_layer')}
              aria-label={localize('com_toolbox_map_add_layer')}
              aria-expanded={menuOpen}
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
            {menuOpen && (
              <>
                {/* 点外部即收起 */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden="true"
                />
                <div className="absolute end-0 top-8 z-20 w-44 rounded-lg border border-border-medium bg-surface-primary py-1 shadow-lg">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-xs transition-colors hover:bg-surface-active-alt"
                    onClick={() => {
                      setMenuOpen(false);
                      setAddOpen(true);
                    }}
                  >
                    <Layers className="size-3.5 text-text-tertiary" aria-hidden="true" />
                    {localize('com_toolbox_map_add_layer')}
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-xs transition-colors hover:bg-surface-active-alt"
                    onClick={() => {
                      setMenuOpen(false);
                      setResolveOpen(true);
                    }}
                  >
                    <Link2 className="size-3.5 text-text-tertiary" aria-hidden="true" />
                    {localize('com_toolbox_map_add_service')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {notice && <p className="text-text-error px-1 pb-1 text-xs">{notice}</p>}
          {/* 图层（顶部 = 最上层；拖拽把手改变绘制次序；右键菜单：缩放/属性/移除） */}
          {[...overlayLayers].reverse().map((l) => (
            <LayerTreeRow
              key={l.key}
              layer={l}
              selected={selectedKey === l.key}
              dragging={draggingKey === l.key}
              onSelect={() => setSelectedKey((prev) => (prev === l.key ? null : l.key))}
              onToggleVisible={() => patchLayer(l.key, { visible: !l.visible })}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ key: l.key, x: e.clientX, y: e.clientY });
              }}
              dragHandle
              onDragPointerDown={beginDrag}
              onDragPointerMove={onDragPointerMove}
              onDragPointerUp={endDrag}
            />
          ))}
          {overlayLayers.length === 0 && (
            <p className="px-1 py-3 text-xs text-text-tertiary">
              {localize('com_toolbox_map_empty_layers')}
            </p>
          )}
          {/* 底图（固定最底层，不参与排序/移除） */}
          {baseLayer && (
            <div className="mt-2 border-t border-border-light pt-2">
              <LayerTreeRow
                layer={{ ...baseLayer, name: localize('com_toolbox_map_base') }}
                selected={selectedKey === baseLayer.key}
                dragging={false}
                onSelect={() =>
                  setSelectedKey((prev) => (prev === baseLayer.key ? null : baseLayer.key))
                }
                onToggleVisible={() => patchLayer(baseLayer.key, { visible: !baseLayer.visible })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ key: baseLayer.key, x: e.clientX, y: e.clientY });
                }}
              />
            </div>
          )}
        </div>
      </aside>

      {/* ── 地图 ──────────────────────────────────────────────── */}
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
          <>
            <div
              ref={containerRef}
              className="absolute inset-0 rounded-lg border border-border-medium"
            />
            <button
              type="button"
              title={localize('com_toolbox_map_fullscreen')}
              aria-label={localize('com_toolbox_map_fullscreen')}
              className="absolute end-2 top-2 z-[1000] rounded-md border border-border-medium bg-surface-primary p-1.5 text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
              onClick={toggleFullscreen}
            >
              <Maximize className="size-3.5" aria-hidden="true" />
            </button>
          </>
        )}
      </main>

      {/* ── 图层属性面板（选中图层时出现在右侧；右键菜单「属性」即打开它） ── */}
      {selectedLayer && (
        <PropsPanel
          layer={selectedLayer}
          featureCount={
            selectedLayer.kind === 'vector'
              ? ((features[selectedLayer.key] as { features?: unknown[] } | undefined)?.features
                  ?.length ?? null)
              : null
          }
          onPatch={patchLayer}
          onFit={selectedLayer.kind === 'vector' ? () => fitLayer(selectedLayer) : undefined}
          onRefresh={selectedLayer.regId ? () => refreshLayer(selectedLayer) : undefined}
          onRemove={
            selectedLayer.kind !== 'base' ? () => removeLayer(selectedLayer.key) : undefined
          }
          onClose={() => setSelectedKey(null)}
        />
      )}

      {/* ── 图层右键菜单（点击/再右键任意处关闭） ──────────────────── */}
      {ctxMenu &&
        (() => {
          const menuLayer = layers.find((l) => l.key === ctxMenu.key);
          if (!menuLayer) {
            return null;
          }
          return (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setCtxMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu(null);
                }}
                aria-hidden="true"
              />
              <div
                role="menu"
                aria-label={localize('com_toolbox_map_layer_menu')}
                className="fixed z-50 w-40 rounded-lg border border-border-medium bg-surface-primary py-1 shadow-lg"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
              >
                {layerContextItems(menuLayer).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className={
                      'flex w-full items-center gap-2 px-3 py-1.5 text-start text-xs transition-colors hover:bg-surface-active-alt ' +
                      (item.danger
                        ? 'text-text-error'
                        : 'text-text-secondary hover:text-text-primary')
                    }
                    onClick={item.onClick}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          );
        })()}

      <AddLayerDialog
        open={addOpen}
        mapServices={boundMaps}
        dataServices={dataServices}
        onAddMap={addTiled}
        onAddVector={addVector}
        onClose={() => setAddOpen(false)}
      />
      <ResolveDialog
        open={resolveOpen}
        resolve={resolve}
        localize={localize}
        onAddMap={addTiled}
        onAddVector={addVector}
        onClose={() => setResolveOpen(false)}
      />
    </div>
  );
}

/** 图层树单行：显隐 + 名称 + 拖拽把手 + 右键菜单。样式控制集中在右侧
 * 属性面板；拖拽用 Pointer 事件自实现：把手上按下捕获指针，移动中命中
 * 哪行就交换到哪行，抬起结束。 */
function LayerTreeRow({
  layer,
  selected,
  dragging,
  onSelect,
  onToggleVisible,
  onContextMenu,
  dragHandle,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerUp,
}: {
  layer: MapLayer;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onToggleVisible: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  dragHandle?: boolean;
  onDragPointerDown?: (e: ReactPointerEvent<HTMLSpanElement>, key: string) => void;
  onDragPointerMove?: (e: ReactPointerEvent<HTMLElement>) => void;
  onDragPointerUp?: () => void;
}) {
  const localize = useLocalize();
  return (
    <div
      data-layer-row={layer.key}
      onContextMenu={onContextMenu}
      onPointerMove={dragHandle ? onDragPointerMove : undefined}
      onPointerUp={dragHandle ? onDragPointerUp : undefined}
      onPointerCancel={dragHandle ? onDragPointerUp : undefined}
    >
      <div
        className={
          'group flex items-center gap-1 rounded-md px-1 py-1 transition-colors ' +
          (selected || dragging ? 'bg-surface-active-alt' : 'hover:bg-surface-active-alt') +
          (dragging ? ' ring-1 ring-border-medium' : '')
        }
      >
        {dragHandle ? (
          <span
            data-drag-handle
            title={localize('com_toolbox_map_drag_handle')}
            aria-label={localize('com_toolbox_map_drag_handle')}
            className="text-text-quaternary shrink-0 cursor-grab touch-none rounded p-0.5 opacity-0 transition-opacity hover:text-text-primary active:cursor-grabbing group-hover:opacity-100"
            onPointerDown={(e) => onDragPointerDown?.(e, layer.key)}
          >
            <GripVertical className="size-3" aria-hidden="true" />
          </span>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
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
          onClick={onToggleVisible}
        >
          {layer.visible ? (
            <Eye className="size-3.5" aria-hidden="true" />
          ) : (
            <EyeOff className="text-text-quaternary size-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded px-0.5 text-start"
          title={layer.name}
          aria-expanded={selected}
          onClick={onSelect}
        >
          {layer.name}
        </button>
      </div>
    </div>
  );
}

/** 右侧图层属性面板：显隐 / 透明度 /（矢量）着色 / 信息 / 缩放 / 重查 / 移除。 */
function PropsPanel({
  layer,
  featureCount,
  onPatch,
  onFit,
  onRefresh,
  onRemove,
  onClose,
}: {
  layer: MapLayer;
  featureCount: number | null;
  onPatch: (key: string, patch: Partial<MapLayer>) => void;
  onFit?: () => void;
  onRefresh?: () => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const kindLabels: Record<LayerKind, string> = {
    vector: localize('com_toolbox_map_kind_vector'),
    tiled: localize('com_toolbox_map_kind_tiled'),
    base: localize('com_toolbox_map_base'),
  };
  const kindLabel = kindLabels[layer.kind];
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border-medium p-3 text-sm">
      <div className="flex items-center gap-1">
        <h3 className="min-w-0 flex-1 truncate font-semibold" title={layer.name}>
          {layer.name || localize('com_toolbox_map_base')}
        </h3>
        <button
          type="button"
          className="text-text-quaternary rounded p-0.5 transition-colors hover:text-text-primary"
          aria-label={localize('com_ui_close')}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-1 text-xs text-text-secondary">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-quaternary">{localize('com_toolbox_map_prop_type')}</span>
          <span>{kindLabel}</span>
        </div>
        {layer.kind === 'vector' && featureCount !== null && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-text-quaternary">
              {localize('com_toolbox_map_prop_features')}
            </span>
            <span>{featureCount}</span>
          </div>
        )}
      </div>

      <label className="flex items-center justify-between gap-2 text-xs">
        <span>
          {layer.visible
            ? localize('com_toolbox_map_layer_hide')
            : localize('com_toolbox_map_layer_show')}
        </span>
        <input
          type="checkbox"
          className="accent-[var(--text-primary)]"
          checked={layer.visible}
          onChange={() => onPatch(layer.key, { visible: !layer.visible })}
        />
      </label>

      <div>
        <p className="text-text-quaternary mb-1 text-xs">
          {localize('com_toolbox_map_opacity')} · {Math.round(layer.opacity * 100)}%
        </p>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          aria-label={`${layer.name} opacity`}
          className="h-1 w-full accent-[var(--text-primary)]"
          value={layer.opacity}
          onChange={(e) => onPatch(layer.key, { opacity: Number(e.target.value) })}
        />
      </div>

      {layer.kind === 'vector' && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-text-quaternary">{localize('com_toolbox_map_style')}</span>
          <input
            type="color"
            aria-label={localize('com_toolbox_map_style')}
            className="size-5 cursor-pointer border-none bg-transparent p-0"
            value={layer.color}
            onChange={(e) => onPatch(layer.key, { color: e.target.value })}
          />
        </div>
      )}

      {(onFit || onRefresh || onRemove) && (
        <div className="flex flex-col gap-1.5">
          {onFit && (
            <PanelAction
              icon={<Crosshair className="size-3.5" aria-hidden="true" />}
              onClick={onFit}
            >
              {localize('com_toolbox_map_fit')}
            </PanelAction>
          )}
          {onRefresh && (
            <PanelAction
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={onRefresh}
            >
              {localize('com_toolbox_map_refresh')}
            </PanelAction>
          )}
          {onRemove && (
            <PanelAction
              icon={<Trash2 className="size-3.5" aria-hidden="true" />}
              danger
              onClick={onRemove}
            >
              {localize('com_toolbox_map_layer_remove')}
            </PanelAction>
          )}
        </div>
      )}
    </aside>
  );
}

function PanelAction({
  icon,
  children,
  danger,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={
        'flex items-center gap-2 rounded-md border border-border-medium px-2.5 py-1.5 text-xs transition-colors hover:bg-surface-active-alt ' +
        (danger
          ? 'hover:text-text-error text-text-secondary'
          : 'text-text-secondary hover:text-text-primary')
      }
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

/** 添加图层弹窗：左列选服务（注册的地图/数据绑定），右列选该服务的地图或数据集。 */
function AddLayerDialog({
  open,
  mapServices,
  dataServices,
  onAddMap,
  onAddVector,
  onClose,
}: {
  open: boolean;
  mapServices: MapServiceEntry[];
  dataServices: DataService[];
  onAddMap: (name: string, serviceUrl: string) => void;
  onAddVector: (name: string, regId: string) => void;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const [target, setTarget] = useState<AddTarget | null>(null);
  const [lastOpen, setLastOpen] = useState(false);
  /* 打开瞬间复位选择（渲染期受控复位，同 PastedTextDialog）。 */
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setTarget(null);
    }
  }

  const rowCls =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-surface-active-alt';

  return (
    <OGDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_toolbox_map_add_layer')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-text-quaternary text-xs font-semibold uppercase">
              {localize('com_toolbox_map_pick_service')}
            </p>
            <div className="max-h-[50vh] min-h-40 overflow-y-auto rounded-lg border border-border-medium p-1">
              {mapServices.map((svc) => (
                <button
                  key={svc.url}
                  type="button"
                  className={
                    rowCls +
                    (target?.kind === 'map' && target.url === svc.url
                      ? ' bg-surface-active-alt'
                      : '')
                  }
                  onClick={() => setTarget(svc)}
                >
                  <Layers className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" title={svc.label}>
                    {svc.label}
                  </span>
                  <ChevronRight
                    className="text-text-quaternary size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                </button>
              ))}
              {dataServices.map((entry) => {
                const active =
                  target?.kind === 'data' && target.entry.bindingId === entry.bindingId;
                return (
                  <button
                    key={entry.bindingId}
                    type="button"
                    className={rowCls + (active ? ' bg-surface-active-alt' : '')}
                    onClick={() => setTarget({ kind: 'data', entry })}
                  >
                    <FolderSearch
                      className="size-4 shrink-0 text-text-tertiary"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate" title={entry.label}>
                      {entry.label}
                    </span>
                    <ChevronRight
                      className="text-text-quaternary size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
              {mapServices.length === 0 && dataServices.length === 0 && (
                <p className="p-3 text-center text-xs text-text-tertiary">
                  {localize('com_toolbox_map_no_bindings')}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-text-quaternary text-xs font-semibold uppercase">
              {localize('com_toolbox_map_pick_layer')}
            </p>
            <div className="max-h-[50vh] min-h-40 overflow-y-auto rounded-lg border border-border-medium p-1">
              {!target && (
                <p className="p-3 text-center text-xs text-text-tertiary">
                  {localize('com_toolbox_map_service')}
                </p>
              )}
              {target?.kind === 'map' && (
                <button
                  type="button"
                  className={rowCls}
                  onClick={() => {
                    onAddMap(target.label, target.url);
                    onClose();
                  }}
                >
                  <Layers className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{target.label}</span>
                </button>
              )}
              {target?.kind === 'data' &&
                target.entry.datasets.map((dataset) => (
                  <button
                    key={dataset.regId}
                    type="button"
                    className={rowCls}
                    onClick={() => {
                      onAddVector(dataset.name, dataset.regId);
                      onClose();
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate" title={dataset.name}>
                      {dataset.name}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>
            {localize('com_ui_cancel')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

/** 添加 REST 服务弹窗：粘贴 iServer 链接 → /services/resolve 识别 → 逐个加层。 */
function ResolveDialog({
  open,
  resolve,
  localize,
  onAddMap,
  onAddVector,
  onClose,
}: {
  open: boolean;
  resolve: ReturnType<typeof useResolveService>;
  localize: ReturnType<typeof useLocalize>;
  onAddMap: (name: string, serviceUrl: string) => void;
  onAddVector: (name: string, regId: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [error, setError] = useState('');
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setUrl('');
      setResolved(null);
      setError('');
    }
  }

  const runResolve = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    setResolved(null);
    setError('');
    try {
      setResolved(await resolve.mutateAsync(trimmed));
    } catch (err) {
      setError(`${localize('com_toolbox_map_detect_fail')}: ${(err as Error).message}`);
    }
  };

  return (
    <OGDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent className="w-11/12 max-w-lg">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_toolbox_map_add_service')}</OGDialogTitle>
        </OGDialogHeader>
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
        {error && <p className="text-text-error text-xs">{error}</p>}
        {resolved && (
          <ResolveCard resolved={resolved} onAddMap={onAddMap} onAddVector={onAddVector} />
        )}
      </OGDialogContent>
    </OGDialog>
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
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md border border-border-medium px-2 py-1.5 text-start text-xs transition-colors hover:bg-surface-active-alt"
        onClick={() => onAddMap(name, serviceUrl)}
      >
        <span className="min-w-0 flex-1 truncate" title={resolved.detail}>
          {name}
        </span>
        {localize('com_toolbox_map_add')}
      </button>
    );
  }
  const hostTag = resolved.base.replace(/^[a-z]+:\/\//, '');
  const service = resolved.service_path.split('/rest/data')[0];
  const datasets = resolved.draft.datasets ?? {};
  return (
    <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto rounded-md border border-border-medium px-2 py-1.5">
      {resolved.draft.datasources?.map((ds) => (
        <div key={ds}>
          <p className="text-text-quaternary text-[10px] uppercase">{ds}</p>
          {(datasets[ds] ?? []).map((name) => (
            <button
              key={name}
              type="button"
              className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-start text-xs transition-colors hover:bg-surface-active-alt"
              onClick={() => onAddVector(name, `${hostTag}|${service}|${ds}|${name}`)}
            >
              <span className="min-w-0 flex-1 truncate" title={name}>
                {name}
              </span>
              {localize('com_toolbox_map_add')}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
