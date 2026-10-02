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
/* 深引 FetchRequest 与图层内部共享同一模块实例（webpack 按解析路径去重），
 * 下方对 get 的超时补丁才作用到矢量瓦片取数上。 */
import { FetchRequest } from '@supermapgis/iclient-common/util/FetchRequest';
import {
  useChoicesFrom,
  useExecuteTool,
  useMapConfig,
  useResolveService,
  useServiceMaps,
  useServices,
  type BindingMap,
  type ResolveResult,
  type ServiceBinding,
} from './api';
import { useLocalize } from '~/hooks';

/* @supermapgis/iclient-leaflet 无 TS 类型：官方 API 最小声明（同 MapPanel）。 */
type IClient = {
  supermap: {
    tiledMapLayer: (url: string) => L.TileLayer;
    /** 矢量瓦片图层（iServer MVT 服务，2.20.0）。 */
    tiledVectorLayer: (
      url: string,
      options?: { format?: string; serverCartoCSSStyle?: boolean; timeout?: number },
    ) => L.TileLayer;
    initMap: (
      url: string,
      options?: { mapOptions?: Record<string, unknown>; layerOptions?: Record<string, unknown> },
    ) => Promise<{ map: L.Map; layer: L.TileLayer }>;
  };
};

type LayerKind = 'base' | 'tiled' | 'vector';

/** 矢量瓦片取数超时兜底。VectorTilePBF.getTile 写死 FetchRequest timeout
 * 10000（_timeout 参数按毫秒计），且超时只放弃 promise、不断底层请求——
 * 动态生成慢的服务（5.28 a4work改前 z7 级单瓦片 >10s 实测）表现为"网络里
 * 有瓦片、图面空白"。对恰好 10s 的请求放宽到 60s；其余请求的超时来自各自
 * options（本文件显式传 60000 的 initLayersInfo 不经此分支）。 */
const TILE_FETCH_TIMEOUT_MS = 60000;
const origFetchRequestGet: typeof FetchRequest.get = FetchRequest.get.bind(FetchRequest);
FetchRequest.get = function (url: string, params?: unknown, options?: { timeout?: number }) {
  if (options?.timeout === 10000) {
    return origFetchRequestGet(url, params, { ...options, timeout: TILE_FETCH_TIMEOUT_MS });
  }
  return origFetchRequestGet(url, params, options);
} as typeof FetchRequest.get;

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

/** 矢量地图服务判定（map-mvt-* 等服务名/URL 含 mvt 段，2.20.0）。 */
const isMvtUrl = (url: string) => url.toLowerCase().includes('mvt');

/** 矢量瓦片取数走 fetch：HTTPS 页面直连 http 内网地址会被 Chrome 混合内容
 * 拦截（栅格 <img> 豁免、矢量不豁免），http 服务经 nginx /iserver/ 同源反代
 * 取（上游固定一台 iServer，2026-09-30 实测）。https 服务不重写——没有混合
 * 内容问题，直连即可（需受信证书+iServer CORS，2026-10-01 5.28 实测），且
 * 单一上游的反代也代不了别的实例。 */
function sameOriginUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      window.location.protocol === 'https:' &&
      parsed.protocol === 'http:' &&
      parsed.origin !== window.location.origin &&
      parsed.pathname.startsWith('/iserver/')
    ) {
      return window.location.origin + parsed.pathname;
    }
  } catch {
    /* 非 URL 形态（相对路径等）原样返回 */
  }
  return url;
}

/** 带超时的 fetch（探测请求不能拖住图层创建）。 */
function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** 矢量瓦片能力探测结果缓存（每个服务 URL 一次，全会话复用）。 */
const vectorTileSupport = new Map<string, Promise<boolean>>();

/** 服务能否出矢量瓦片（结果按 URL 缓存）。 */
function supportsVectorTiles(url: string): Promise<boolean> {
  let p = vectorTileSupport.get(url);
  if (!p) {
    p = probeVectorTiles(url);
    vectorTileSupport.set(url, p);
  }
  return p;
}

/** 探测：数据源为矢量的 REST 地图服务都能出 tileFeature.mvt（2026-10-01
 * 用户指定，不按服务名 mvt 限死）。请求整幅 viewBounds 的 MVT，有字节即
 * 支持；空/404/超时回落栅格切图（栅格当前总是可用，不回归）。 */
async function probeVectorTiles(url: string): Promise<boolean> {
  if (isMvtUrl(url)) {
    /* mvt 服务本身就是矢量瓦片服务（缓存缺失时该服务整体无图，探测无意义） */
    return true;
  }
  try {
    const base = sameOriginUrl(url).replace(/\/+$/, '');
    const meta = (await fetchWithTimeout(`${base}.json`, 8000).then((r) =>
      r.ok ? r.json() : null,
    )) as {
      coordUnit?: string;
      viewBounds?: { left?: number; bottom?: number; right?: number; top?: number };
    } | null;
    const v = meta?.viewBounds;
    if (
      !v ||
      typeof v.left !== 'number' ||
      typeof v.bottom !== 'number' ||
      typeof v.right !== 'number' ||
      typeof v.top !== 'number'
    ) {
      return false;
    }
    /* 整幅出图（范围全宽进一张 512 请求）：分辨率=范围宽/512，换算
     * SuperMap scale（DEGREE 用米/度，METER 直接 1）。 */
    const resolution = Math.abs(v.right - v.left) / 512;
    const meterPerUnit = meta?.coordUnit === 'METER' ? 1 : (Math.PI * 6378137.0) / 180.0;
    const scale = 1 / (resolution * 96 * (1 / 0.0254) * meterPerUnit);
    const q = new URLSearchParams({
      origin: JSON.stringify({ x: -180, y: 90 }),
      returnAttributes: 'false',
      cacheEnabled: 'false',
      width: '512',
      height: '512',
      viewBounds: JSON.stringify({ left: v.left, bottom: v.bottom, right: v.right, top: v.top }),
      scale: String(scale),
    });
    const resp = await fetchWithTimeout(`${base}/tileFeature.mvt?${q.toString()}`, 15000);
    if (!resp.ok) {
      return false;
    }
    return (await resp.arrayBuffer()).byteLength > 0;
  } catch {
    return false;
  }
}

/** iClient 矢量瓦片图层的内部结构（仅取需要的成员，签名对齐运行时）。 */
type VectorLayerInternals = {
  /** _initLayerUrl 拼好的基址：tileFeature.mvt?origin=…&width=… 等（不含 x/y） */
  _tileUrl: string;
  _crs: { project(latlng: L.LatLng): L.Point };
  _getTileUrl: (coords: { x: number; y: number; z: number }) => string;
  getScaleFromCoords: (coords: { z: number }) => number;
  _tileCoordsToBounds: (coords: { x: number; y: number; z: number }) => L.LatLngBounds;
};

/** 逐瓦片请求改写为 viewBounds 形式。动态地图服务不支持 iClient 默认的
 * 瓦片索引（x/y+scale）取数：5.28 实测任意 origin/scale 组合下 x/y 形式的
 * tileFeature.mvt 一律 200+0 字节，viewBounds 形式才出真实数据（单瓦片
 * 898KB，且 scale 不必对齐服务 visibleScales）。按 Leaflet 行列号用当前
 * CRS 算出瓦片地理范围改发 viewBounds——探测（probeVectorTiles）同形，
 * 行为一致。 */
function rewriteTileUrlToViewBounds(layer: L.TileLayer): void {
  const vl = layer as unknown as VectorLayerInternals;
  vl._getTileUrl = (coords) => {
    if (!vl._crs) {
      /* onAdd 前不会取瓦片；防御性回落避免渲染线程抛错 */
      return vl._tileUrl;
    }
    const bounds = vl._tileCoordsToBounds(coords);
    const sw = vl._crs.project(bounds.getSouthWest());
    const ne = vl._crs.project(bounds.getNorthEast());
    const viewBounds = JSON.stringify({
      leftBottom: { x: sw.x, y: sw.y },
      rightTop: { x: ne.x, y: ne.y },
    });
    return `${vl._tileUrl}&viewBounds=${encodeURIComponent(viewBounds)}&scale=${vl.getScaleFromCoords(coords)}`;
  };
}

/** 建瓦片图层：探测支持矢量瓦片的（mvt 服务、数据源为矢量的动态地图服务）
 * 走 iClient 矢量瓦片（https 直连或同源反代 + MVT），其余栅格切图（用户指
 * 定的浏览器直连策略，2026-09-29）。 */
async function makeTileLayer(url: string): Promise<L.TileLayer> {
  const iclient = (L as unknown as IClient).supermap;
  if (await supportsVectorTiles(url)) {
    const layer = iclient.tiledVectorLayer(sameOriginUrl(url), {
      /* iServer MVT 服务仅出 tileFeature.mvt（默认 JSON 返回 400，实测）；
       * serverCartoCSSStyle 关掉：矢量瓦片服务无 vectorstyles 端点（5.28
       * 动态地图同样 404），开着会永远等不到出图回调，样式回落图层自带
       * 配置。timeout 管元数据请求（initLayersInfo 拉图层信息，默认 10s
       * 在慢服务上不够）；逐瓦片的硬编码超时由 FetchRequest 补丁兜住。 */
      format: 'MVT',
      serverCartoCSSStyle: false,
      timeout: TILE_FETCH_TIMEOUT_MS,
    }) as unknown as L.TileLayer;
    rewriteTileUrlToViewBounds(layer);
    return layer;
  }
  return iclient.tiledMapLayer(url);
}

/** 添加图层弹窗里的服务条目（注册表绑定按绑定 id 聚合出的数据服务）。 */
type DataService = {
  bindingId: string;
  label: string;
  datasets: { name: string; regId: string }[];
};
type MapServiceEntry = { kind: 'map'; bindingId: string; label: string; rootUrl: string };
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
  const baseLayersRef = useRef<L.TileLayer[]>([]);
  const instances = useRef<Map<string, L.Layer>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const fitted = useRef<Set<string>>(new Set());
  /* 瓦片图层异步创建（探测矢量瓦片能力）的去重与落地校验。 */
  const pendingTiles = useRef<Map<string, Promise<L.TileLayer>>>(new Map());
  const layersRef = useRef(layers);
  layersRef.current = layers;
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

  /* 底图组条目（2.20.0）：basemaps 数组优先，env 回落单幅；树按此分幅显示。 */
  const basemapEntries = useMemo(() => {
    if (config?.basemaps?.length) {
      return config.basemaps;
    }
    return config?.map_url ? [{ name: '', url: config.map_url }] : [];
  }, [config]);

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

    /* 底图组（2.19.0）：按 basemaps 数组序叠放（前者在下）；env 回落时单幅。 */
    const basemapUrls = basemapEntries.map((b) => b.url).filter(Boolean);

    /* 底图逐幅异步建层（类型按探测决定）：单幅失败只跳过自身，不塌面板。 */
    const fallbackInit = async () => {
      const map = L.map(el, {
        zoomControl: true,
        ...view,
        ...(degreeCrs ? { crs: degreeCrs } : {}),
      });
      const layerList: L.TileLayer[] = [];
      for (const url of basemapUrls) {
        try {
          layerList.push(await makeTileLayer(url));
        } catch (error) {
          console.warn('[MapBrowser] 底图创建失败:', url, error);
        }
      }
      layerList.forEach((layer) => layer.addTo(map));
      baseLayersRef.current = layerList;
      return map;
    };

    (async () => {
      let map: L.Map;
      try {
        if (await supportsVectorTiles(basemapUrls[0] ?? '')) {
          // 首幅是矢量瓦片图层：initMap 只识别栅格切图协议，直接走 fallback
          throw new Error('vector-basemap');
        }
        el.id = 'map'; // initMap 以固定 id 建图（首幅底图走官方切图方案）
        const created = await iclient.initMap(basemapUrls[0], {
          mapOptions: { zoomControl: true, ...view },
        });
        map = created.map;
        baseLayersRef.current = [created.layer];
        for (const url of basemapUrls.slice(1)) {
          try {
            const layer = await makeTileLayer(url);
            layer.addTo(map);
            baseLayersRef.current.push(layer);
          } catch (error) {
            /* 此处再失败不能落回 fallback（地图已建好，容器重初始化会抛错） */
            console.warn('[MapBrowser] 底图创建失败:', url, error);
          }
        }
      } catch {
        delete (el as unknown as { _leaflet_id?: number })._leaflet_id;
        map = await fallbackInit();
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
      baseLayersRef.current = [];
      inst.clear();
      fittedSet.clear();
    };
  }, [config, basemapEntries]);

  const baseLayer = layers.find((l) => l.kind === 'base');
  /* 底图分幅显隐（2.20.0）：每幅独立（未记录默认可见）；透明度仍整组统一。 */
  const [baseVisibility, setBaseVisibility] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    baseLayersRef.current.forEach((base, i) => {
      const name = basemapEntries[i]?.name ?? '';
      /* 单幅底图异常只影响自身（矢量瓦片容器异步就绪等），不能崩整个面板 */
      try {
        if (baseVisibility[name] ?? true) {
          if (!map.hasLayer(base)) {
            base.addTo(map);
          }
          try {
            base.setOpacity(baseLayer?.opacity ?? 1);
          } catch {
            /* 容器未就绪时跳过，就绪后下次同步生效 */
          }
        } else if (map.hasLayer(base)) {
          map.removeLayer(base);
        }
      } catch (error) {
        console.warn('[MapBrowser] 底图同步失败:', name || i, error);
      }
    });
  }, [basemapEntries, baseVisibility, baseLayer, mapReady]);

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
      /* 单个坏图层只影响自身：创建/挂载失败时移除实例记录，下次同步重建
       * （2.20.0 实测：矢量瓦片图层异常曾致整面板白屏崩溃）。 */
      try {
        const tile = inst.get(l.key) as L.TileLayer | undefined;
        if (!tile) {
          /* 图层类型按探测异步决定（矢量瓦片/栅格，2.20.1）：pending 去重；
           * 落地前按最新 layers 校验（创建期间可能已被删/换地图），属性由
           * 落地处直接补齐（同步 effect 不会再因创建完成而重跑）。 */
          const key = l.key;
          let creating = pendingTiles.current.get(key);
          if (!creating) {
            creating = makeTileLayer(l.url);
            pendingTiles.current.set(key, creating);
          }
          creating
            .then((created) => {
              pendingTiles.current.delete(key);
              if (mapRef.current !== map) {
                return;
              }
              const cur = layersRef.current.find((x) => x.key === key);
              if (!cur) {
                return;
              }
              inst.set(key, created);
              if (cur.visible && !map.hasLayer(created)) {
                created.addTo(map);
              }
              try {
                created.setOpacity(cur.opacity);
                created.setZIndex(layersRef.current.findIndex((x) => x.key === key) + 10);
              } catch {
                /* 容器未就绪时跳过，就绪后下次同步生效 */
              }
            })
            .catch((error) => {
              pendingTiles.current.delete(key);
              console.warn('[MapBrowser] 图层创建失败:', l.name, error);
            });
          return;
        }
        if (l.visible) {
          if (!map.hasLayer(tile)) {
            tile.addTo(map);
          }
          try {
            tile.setOpacity(l.opacity);
            tile.setZIndex(idx + 10);
          } catch {
            /* 容器未就绪时跳过（矢量瓦片挂载初期），就绪后下次同步生效 */
          }
        } else if (map.hasLayer(tile)) {
          map.removeLayer(tile);
        }
      } catch (error) {
        console.warn('[MapBrowser] 图层同步失败:', l.name, error);
        const bad = inst.get(l.key);
        if (bad) {
          try {
            map.removeLayer(bad);
          } catch {
            /* 移除失败同样忽略 */
          }
          inst.delete(l.key);
        }
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
  /* 地图绑定 = 服务级（2.18.0）：具体地图在添加图层弹窗内列出并多选导入 */
  const mapsRootOf = (servicePath: string) => {
    const p = `iserver/services/${servicePath.replace(/^\/+/, '')}`;
    const k = p.indexOf('/rest/maps/');
    if (k >= 0) {
      return p.slice(0, k + '/rest/maps'.length);
    }
    return p.endsWith('/rest/maps') ? p : `${p}/rest/maps`;
  };
  const boundMaps: MapServiceEntry[] = services
    .filter((s) => s.type === 'iserver_map' && s.status === 'available')
    .map((s) => ({
      kind: 'map' as const,
      bindingId: s.id,
      label: s.name,
      rootUrl: `${s.base_url.replace(/\/+$/, '')}/${mapsRootOf(s.service_path)}`,
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
          {/* 底图组：每幅一行、各自显隐（固定最底层，不参与排序/移除/属性） */}
          {basemapEntries.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5 border-t border-border-light pt-2">
              {basemapEntries.map((b, i) => {
                const name =
                  b.name ||
                  (basemapEntries.length > 1
                    ? `${localize('com_toolbox_map_base')} ${i + 1}`
                    : localize('com_toolbox_map_base'));
                return (
                  <LayerTreeRow
                    key={`base:${i}`}
                    layer={{
                      key: `base:${i}`,
                      kind: 'base',
                      name,
                      visible: baseVisibility[b.name] ?? true,
                      opacity: baseLayer?.opacity ?? 1,
                      color: VECTOR_COLORS[0],
                    }}
                    selected={false}
                    dragging={false}
                    onSelect={() => setSelectedKey(null)}
                    onToggleVisible={() =>
                      setBaseVisibility((prev) => ({ ...prev, [b.name]: !(prev[b.name] ?? true) }))
                    }
                    onContextMenu={(e) => e.preventDefault()}
                  />
                );
              })}
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

/** 添加图层弹窗：左列选服务（注册的地图/数据绑定），右列多选该服务下的
 * 地图/数据集，点「导入所选」批量入图（2.18.0）。 */
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
  const [pickedMaps, setPickedMaps] = useState<string[]>([]);
  const [pickedVectors, setPickedVectors] = useState<string[]>([]);
  const [svcFilter, setSvcFilter] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [lastOpen, setLastOpen] = useState(false);
  const serviceId = target?.kind === 'map' ? target.bindingId : null;
  const mapsQuery = useServiceMaps(serviceId, open);
  /* 打开瞬间复位选择（渲染期受控复位，同 PastedTextDialog）。 */
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setTarget(null);
      setPickedMaps([]);
      setPickedVectors([]);
      setSvcFilter('');
      setLayerFilter('');
    }
  }

  const match = (text: string, q: string) => text.toLowerCase().includes(q.trim().toLowerCase());
  const rowCls =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-surface-active-alt';
  const check =
    'flex size-4 shrink-0 items-center justify-center rounded border border-border-medium';

  const toggle = (list: string[], key: string) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  const importPicked = () => {
    if (target?.kind === 'map') {
      for (const m of mapsQuery.data?.maps ?? []) {
        if (!pickedMaps.includes(m.name)) {
          continue;
        }
        onAddMap(m.name, m.path || target.rootUrl + '/' + m.name);
      }
    } else if (target?.kind === 'data') {
      for (const dataset of target.entry.datasets) {
        if (pickedVectors.includes(dataset.regId)) {
          onAddVector(dataset.name, dataset.regId);
        }
      }
    }
    onClose();
  };
  const pickedCount = target?.kind === 'map' ? pickedMaps.length : pickedVectors.length;

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
            <input
              type="search"
              className="mb-1 w-full rounded-lg border border-border-light bg-surface-primary px-3 py-1.5 text-sm text-text-primary placeholder-text-tertiary focus:border-border-medium focus:outline-none"
              placeholder={localize('com_toolbox_map_search')}
              aria-label={localize('com_toolbox_map_search')}
              value={svcFilter}
              onChange={(e) => setSvcFilter(e.target.value)}
            />
            <div className="max-h-[50vh] min-h-40 overflow-y-auto rounded-lg border border-border-medium p-1">
              {mapServices
                .filter((svc) => match(svc.label, svcFilter))
                .map((svc) => (
                  <button
                    key={svc.bindingId}
                    type="button"
                    className={
                      rowCls +
                      (target?.kind === 'map' && target.bindingId === svc.bindingId
                        ? ' bg-surface-active-alt'
                        : '')
                    }
                    onClick={() => {
                      setTarget(svc);
                      setPickedMaps([]);
                    }}
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
              {dataServices
                .filter((entry) => match(entry.label, svcFilter))
                .map((entry) => {
                  const active =
                    target?.kind === 'data' && target.entry.bindingId === entry.bindingId;
                  return (
                    <button
                      key={entry.bindingId}
                      type="button"
                      className={rowCls + (active ? ' bg-surface-active-alt' : '')}
                      onClick={() => {
                        setTarget({ kind: 'data', entry });
                        setPickedVectors([]);
                      }}
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
            <input
              type="search"
              className="mb-1 w-full rounded-lg border border-border-light bg-surface-primary px-3 py-1.5 text-sm text-text-primary placeholder-text-tertiary focus:border-border-medium focus:outline-none"
              placeholder={localize('com_toolbox_map_search')}
              aria-label={localize('com_toolbox_map_search')}
              value={layerFilter}
              onChange={(e) => setLayerFilter(e.target.value)}
            />
            <div className="max-h-[40vh] min-h-40 overflow-y-auto rounded-lg border border-border-medium p-1">
              {!target && (
                <p className="p-3 text-center text-xs text-text-tertiary">
                  {localize('com_toolbox_map_service')}
                </p>
              )}
              {target?.kind === 'map' && (
                <>
                  {mapsQuery.isLoading && (
                    <p className="p-3 text-center text-xs text-text-tertiary">
                      {localize('com_toolbox_cloud_loading')}
                    </p>
                  )}
                  {mapsQuery.isError && (
                    <p className="text-text-error p-3 text-center text-xs">
                      {(mapsQuery.error as Error).message}
                    </p>
                  )}
                  {(mapsQuery.data?.maps ?? [])
                    .filter((m) => match(m.name, layerFilter))
                    .map((m: BindingMap) => {
                      const picked = pickedMaps.includes(m.name);
                      return (
                        <button
                          key={m.name}
                          type="button"
                          aria-pressed={picked}
                          className={rowCls}
                          onClick={() => setPickedMaps((prev) => toggle(prev, m.name))}
                        >
                          <span
                            className={check + (picked ? ' border-indigo-500 bg-indigo-500' : '')}
                            aria-hidden="true"
                          >
                            {picked && <span className="size-2 rounded-sm bg-white" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={m.name}>
                            {m.name}
                          </span>
                        </button>
                      );
                    })}
                  {!mapsQuery.isLoading && (mapsQuery.data?.maps ?? []).length === 0 && (
                    <p className="p-3 text-center text-xs text-text-tertiary">
                      {localize('com_toolbox_cloud_empty')}
                    </p>
                  )}
                </>
              )}
              {target?.kind === 'data' && (
                <>
                  {target.entry.datasets.length === 0 && (
                    <p className="p-3 text-center text-xs text-text-tertiary">
                      {localize('com_toolbox_cloud_empty')}
                    </p>
                  )}
                  {target.entry.datasets
                    .filter((dataset) => match(dataset.name, layerFilter))
                    .map((dataset) => {
                      const picked = pickedVectors.includes(dataset.regId);
                      return (
                        <button
                          key={dataset.regId}
                          type="button"
                          aria-pressed={picked}
                          className={rowCls}
                          onClick={() => setPickedVectors((prev) => toggle(prev, dataset.regId))}
                        >
                          <span
                            className={check + (picked ? ' border-indigo-500 bg-indigo-500' : '')}
                            aria-hidden="true"
                          >
                            {picked && <span className="size-2 rounded-sm bg-white" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={dataset.name}>
                            {dataset.name}
                          </span>
                        </button>
                      );
                    })}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 pt-2">
          <span className="text-xs text-text-tertiary">
            {pickedCount > 0
              ? localize('com_toolbox_map_picked_count', { n: String(pickedCount) })
              : ''}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {localize('com_ui_cancel')}
            </Button>
            <Button variant="default" disabled={pickedCount === 0} onClick={importPicked}>
              {localize('com_toolbox_map_import_picked')}
            </Button>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

/** 添加 REST 服务弹窗：粘贴 iServer 链接 → /services/resolve 识别 → 多选导入。 */
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

/** 识别结果卡（2.18.0 直连版）：完整链接解析后直接列出可加图层，
 * 多选后一次导入——不再让用户分类型/逐个点。 */
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
  const isMap = resolved.type === 'iserver_map';
  /* 地图：draft.maps = 服务内全部地图（单地图链接时仅 1 项）。 */
  const mapItems = (resolved.draft.maps ?? []).map((name) => {
    const rootUrl =
      resolved.base.replace(/\/+$/, '') +
      '/iserver/services/' +
      resolved.service_path.replace(/^\/+/, '').replace(/(\/rest\/maps)\/.*/, '$1');
    return { name, url: rootUrl + '/' + name };
  });
  /* 数据：按数据源展开全部数据集（四段临时 regId）。 */
  const hostTag = resolved.base.replace(/^[a-z]+:\/\//, '');
  const service = resolved.service_path.split('/rest/data')[0];
  const vectorItems = (resolved.draft.datasources ?? []).flatMap((ds) =>
    (resolved.draft.datasets?.[ds] ?? []).map((name) => ({
      key: `${hostTag}|${service}|${ds}|${name}`,
      name,
      ds,
    })),
  );
  const items = isMap ? mapItems.map((m) => m.name) : vectorItems.map((v) => v.key);
  const [picked, setPicked] = useState<string[]>(items);
  const [lastKey, setLastKey] = useState('');
  const key = `${resolved.type}:${resolved.service_path}`;
  if (key !== lastKey) {
    setLastKey(key);
    setPicked(items);
  }

  if (resolved.status !== 'available') {
    return (
      <p className="text-text-error rounded-md border border-border-medium px-2 py-1.5 text-xs">
        {resolved.detail || resolved.status}
      </p>
    );
  }

  const rowCls =
    'flex w-full items-center gap-2 rounded px-1.5 py-1 text-start text-xs transition-colors hover:bg-surface-active-alt';
  const check =
    'flex size-3.5 shrink-0 items-center justify-center rounded border border-border-medium';
  const toggle = (k: string) =>
    setPicked((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const importPicked = () => {
    if (isMap) {
      for (const m of mapItems) {
        if (picked.includes(m.name)) {
          onAddMap(m.name, m.url);
        }
      }
    } else {
      for (const v of vectorItems) {
        if (picked.includes(v.key)) {
          onAddVector(v.name, v.key);
        }
      }
    }
  };
  const importLabel = localize('com_toolbox_map_import_picked');

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border-medium px-2 py-1.5">
        {items.length === 0 && (
          <p className="p-2 text-center text-xs text-text-tertiary">
            {localize('com_toolbox_cloud_empty')}
          </p>
        )}
        {isMap &&
          mapItems.map((m) => {
            const pickedOn = picked.includes(m.name);
            return (
              <button
                key={m.name}
                type="button"
                aria-pressed={pickedOn}
                className={rowCls}
                onClick={() => toggle(m.name)}
              >
                <span
                  className={check + (pickedOn ? ' border-indigo-500 bg-indigo-500' : '')}
                  aria-hidden="true"
                >
                  {pickedOn && <span className="size-2 rounded-sm bg-white" />}
                </span>
                <span className="min-w-0 flex-1 truncate" title={m.name}>
                  {m.name}
                </span>
              </button>
            );
          })}
        {!isMap &&
          vectorItems.map((v) => {
            const pickedOn = picked.includes(v.key);
            return (
              <button
                key={v.key}
                type="button"
                aria-pressed={pickedOn}
                className={rowCls}
                onClick={() => toggle(v.key)}
              >
                <span
                  className={check + (pickedOn ? ' border-indigo-500 bg-indigo-500' : '')}
                  aria-hidden="true"
                >
                  {pickedOn && <span className="size-2 rounded-sm bg-white" />}
                </span>
                <span className="text-text-quaternary w-24 shrink-0 truncate" title={v.ds}>
                  {v.ds}
                </span>
                <span className="min-w-0 flex-1 truncate" title={v.name}>
                  {v.name}
                </span>
              </button>
            );
          })}
      </div>
      <div className="flex justify-end">
        <Button variant="default" disabled={picked.length === 0} onClick={importPicked}>
          {importLabel}
          {picked.length > 0 ? ` (${picked.length})` : ''}
        </Button>
      </div>
    </div>
  );
}
