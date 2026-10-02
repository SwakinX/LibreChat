import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { request } from 'librechat-data-provider';
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
import 'mapbox-gl/dist/mapbox-gl.css';
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

/** 官方 vectorstyles.json 返回结构的最小声明（iclient-mapboxgl InitMap 同源）。 */
type StyleJSON = {
  version: number;
  sources: Record<string, Record<string, unknown>>;
  layers: Record<string, unknown>[];
  glyphs?: string;
  sprite?: string;
};

/** 引擎侧图层句柄：一个图层状态对应的一组 mapbox style 资源。 */
type LayerHandle = {
  sourceIds: string[];
  /** style 图层 id + 类型（显隐走 layout，透明度/着色按类型写 paint）。 */
  layers: { id: string; type: string }[];
  kind: 'raster' | 'vector' | 'geojson';
};

/* @types/mapbox-gl 各版本对 Layer/Source 联合类型的命名差异大（v1 AnyLayer、
 * v3 改名），统一取 addLayer/addSource 的参数类型做断言——运行时对象来自
 * 官方样式或本文件构造，类型层面只求版本无关。 */
type AddLayerArg = Parameters<mapboxgl.Map['addLayer']>[0];
type AddSourceArg = Parameters<mapboxgl.Map['addSource']>[1];

/** 矢量取数走 fetch：HTTPS 页面直连 http 内网地址会被 Chrome 混合内容
 * 拦截，http 服务经 nginx /iserver/ 同源反代取（上游固定一台 iServer，
 * 2026-09-30 实测）。https 服务不重写——直连即可（需受信证书+iServer
 * CORS），且单一上游的反代也代不了别的实例。 */
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

/** 带超时的 fetch（样式探测不能拖住建图）。 */
function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** 栅格 ZXY 模板（官方 iclient-mapboxgl README 同款）：zxyTileImage.png +
 * prjCoordSys 3857——服务端把 4326/4490 底图重投影进 Mercator 瓦片网格，
 * 这是度坐标系服务上 Mercator 引擎的官方出图路径。{z}/{x}/{y} 模板记号
 * 必须保持字面量（mapbox-gl 运行时替换），故手工拼串不走 URLSearchParams。 */
function rasterTileTemplate(url: string): string {
  const base = sameOriginUrl(url).replace(/\/+$/, '');
  const prj = encodeURIComponent(JSON.stringify({ epsgCode: 3857 }));
  return `${base}/zxyTileImage.png?prjCoordSys=${prj}&z={z}&x={x}&y={y}&width=256&height=256&transparent=true`;
}

/** 栅格瓦片摘要（sanity 判断用）：z6 起步按模板取单瓦片并哈希；失败返回
 * null（探测不阻塞出图）。 */
async function rasterTileDigest(
  url: string,
  z: number,
  x: number,
  y: number,
): Promise<string | null> {
  try {
    const u = rasterTileTemplate(url)
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const resp = await fetchWithTimeout(u, 15000);
    if (!resp.ok) {
      return null;
    }
    const digest = await crypto.subtle.digest('SHA-256', await resp.arrayBuffer());
    return Array.from(new Uint8Array(digest).slice(0, 16))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

/** 官方矢量瓦片样式：经服务端判断代理获取（/map/vectorstyle）。浏览器不直接
 * 请求 iServer 的 vectorstyles.json——栅格服务上那是一次无法抑制的 404 控制
 * 台报错；服务端探测后浏览器永远拿到 200（样式 JSON 或 capable:false），
 * 结果按 URL 缓存全会话复用。必须走 request（自动附 JWT）——裸 fetch 会被
 * requireJwtAuth 拒之门外（401，实测）。 */
const vectorStyleCache = new Map<string, Promise<StyleJSON | null>>();

function getVectorStyle(url: string): Promise<StyleJSON | null> {
  let p = vectorStyleCache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const payload = (await request.get(
          `/api/terravox/map/vectorstyle?url=${encodeURIComponent(url)}`,
          { timeout: 30000 },
        )) as { capable: boolean; style?: StyleJSON };
        if (!payload?.capable || !payload.style) {
          return null;
        }
        return payload.style;
      } catch {
        return null;
      }
    })();
    vectorStyleCache.set(url, p);
  }
  return p;
}

/** 栅格瓦片图层（zxyTileImage 官方模板）。 */
function addRasterHandle(map: mapboxgl.Map, key: string, url: string): LayerHandle {
  const sourceId = `${key}:src`;
  const layerId = `${key}:lyr`;
  map.addSource(sourceId, {
    type: 'raster',
    tiles: [rasterTileTemplate(url)],
    tileSize: 256,
    attribution: '© SuperMap iServer',
  } as unknown as AddSourceArg);
  map.addLayer({ id: layerId, type: 'raster', source: sourceId });
  return { sourceIds: [sourceId], layers: [{ id: layerId, type: 'raster' }], kind: 'raster' };
}

/** 官方矢量瓦片样式并入地图：source/layer id 加 key 前缀防多服务冲突。
 * 文本图层依赖 glyphs/sprite，它们是 style 级配置——仅首个服务的能在建图
 * 时声明；后续服务若带文本图层且缺 glyphs，引擎会拒绝该层（错误事件可见），
 * 其余图层不受影响。 */
function addVectorHandle(map: mapboxgl.Map, key: string, style: StyleJSON): LayerHandle {
  const sourceIds: string[] = [];
  const sourceMap: Record<string, string> = {};
  for (const [id, src] of Object.entries(style.sources)) {
    const sid = `${key}:${id}`;
    sourceIds.push(sid);
    sourceMap[id] = sid;
    if (!map.getSource(sid)) {
      /* 样式里的瓦片模板指向 iServer 源站：http 目标过同源代理，https 直连 */
      const tiles = (src as { tiles?: string[] }).tiles?.map((t) => sameOriginUrl(t));
      map.addSource(sid, {
        ...(src as object),
        ...(tiles ? { tiles } : {}),
      } as unknown as AddSourceArg);
    }
  }
  const layers: { id: string; type: string }[] = [];
  (style.layers ?? []).forEach((lyr, i) => {
    const rec = lyr as { source?: string; type?: string };
    /* background 层跳过：每个官方样式都自带一块不透明背景，多服务合并时
     * 后加的会把整个地图连同下方所有要素盖住（实测满屏橄榄绿）——底图
     * 职责归栅格底图，样式只贡献要素层。 */
    if (rec.type === 'background') {
      return;
    }
    const lid = `${key}:lyr-${i}`;
    /* background 之外的图层若仍无 source（异常样式），原样保留缺省
     * （补 undefined 会被引擎整层拒绝——曾有 116 条校验错误）。 */
    const merged: Record<string, unknown> = { ...lyr, id: lid };
    if (rec.source) {
      merged.source = sourceMap[rec.source] ?? rec.source;
    }
    map.addLayer(merged as unknown as AddLayerArg);
    layers.push({ id: lid, type: rec.type ?? 'background' });
  });
  return { sourceIds, layers, kind: 'vector' };
}

/** GeoJSON 中出现的几何大类（要素几何为 null/缺失时跳过）。 */
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

/** GeoJSON 要素范围（fitBounds 用；替代 Leaflet 的 geo.getBounds）。 */
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

/** GeoJSON 图层：source 常驻（重查 setData 原地更新），按出现的几何类型建
 * circle/line/fill（点=圆点、线=2px、面=25% 填充，延续 Leaflet 版风格）。 */
function addGeojsonHandle(
  map: mapboxgl.Map,
  key: string,
  data: unknown,
  color: string,
): LayerHandle {
  const sourceId = `${key}:src`;
  map.addSource(sourceId, { type: 'geojson', data } as unknown as AddSourceArg);
  const kinds = geometryKinds(data);
  const layers: { id: string; type: string }[] = [];
  const add = (suffix: string, type: string, layer: Record<string, unknown>): void => {
    map.addLayer(layer as unknown as AddLayerArg);
    layers.push({ id: `${key}:${suffix}`, type });
  };
  if (kinds.point) {
    add('pt', 'circle', {
      id: `${key}:pt`,
      type: 'circle',
      source: sourceId,
      paint: {
        'circle-radius': 5,
        'circle-color': color,
        'circle-stroke-color': color,
        'circle-stroke-width': 2,
      },
    });
  }
  if (kinds.line) {
    add('ln', 'line', {
      id: `${key}:ln`,
      type: 'line',
      source: sourceId,
      paint: { 'line-color': color, 'line-width': 2 },
    });
  }
  if (kinds.polygon) {
    add('pg', 'fill', {
      id: `${key}:pg`,
      type: 'fill',
      source: sourceId,
      paint: { 'fill-color': color, 'fill-opacity': 0.25, 'fill-outline-color': color },
    });
  }
  return { sourceIds: [sourceId], layers, kind: 'geojson' };
}

/** 显隐同步（隐藏的层保留在 style 里，layout.visibility 切换）。 */
function setHandleVisible(map: mapboxgl.Map, handle: LayerHandle, visible: boolean): void {
  for (const { id } of handle.layers) {
    try {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    } catch {
      /* 图层尚未落地/已被移除：忽略，下次同步再写 */
    }
  }
}

/** 透明度/着色同步：按图层类型写对应 paint 属性。面填充按 Leaflet 版惯例
 * 取 opacity 的 1/4，描边/线/点全量。 */
function applyHandleStyle(
  map: mapboxgl.Map,
  handle: LayerHandle,
  opts: { opacity: number; color?: string },
): void {
  for (const { id, type } of handle.layers) {
    try {
      if (type === 'raster') {
        map.setPaintProperty(id, 'raster-opacity', opts.opacity);
      } else if (type === 'fill') {
        map.setPaintProperty(id, 'fill-opacity', opts.opacity * 0.25);
        if (opts.color) {
          map.setPaintProperty(id, 'fill-color', opts.color);
          map.setPaintProperty(id, 'fill-outline-color', opts.color);
        }
      } else if (type === 'line') {
        map.setPaintProperty(id, 'line-opacity', opts.opacity);
        if (opts.color) {
          map.setPaintProperty(id, 'line-color', opts.color);
        }
      } else if (type === 'circle') {
        map.setPaintProperty(id, 'circle-opacity', opts.opacity);
        map.setPaintProperty(id, 'circle-stroke-opacity', opts.opacity);
        if (opts.color) {
          map.setPaintProperty(id, 'circle-color', opts.color);
          map.setPaintProperty(id, 'circle-stroke-color', opts.color);
        }
      }
    } catch {
      /* 图层尚未落地/已被移除：忽略 */
    }
  }
}

/** 摘除句柄的全部 style 资源（先层后源）。 */
function removeHandle(map: mapboxgl.Map, handle: LayerHandle): void {
  for (const { id } of handle.layers) {
    try {
      map.removeLayer(id);
    } catch {
      /* 已被移除：忽略 */
    }
  }
  for (const sid of handle.sourceIds) {
    try {
      map.removeSource(sid);
    } catch {
      /* 源仍被引用等：忽略 */
    }
  }
}

function mapBbox(map: mapboxgl.Map): [number, number, number, number] {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
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

/**
 * 地图浏览器（?panel=map 独立面板，2.16.0）：GIS 风格图层树 + Mapbox GL 出图
 * （2.21.0 引擎自 Leaflet 迁至 mapbox-gl + 官方 SuperMap iClient for MapboxGL
 * 服务模板）。矢量瓦片/动态矢量瓦片统一走官方 vectorstyles.json 样式（取不到
 * 回落 zxyTileImage 栅格，两条都是 iclient-mapboxgl 的官方路径，无自写桥接）；
 * 度坐标系服务由服务端按 prjCoordSys 3857 重投影进 Mercator 网格。
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
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const baseHandlesRef = useRef<Map<string, LayerHandle>>(new Map());
  const handlesRef = useRef<Map<string, LayerHandle>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const fitted = useRef<Set<string>>(new Set());
  /* 瓦片图层异步创建（vectorstyles 探测）的去重；落地经 mapReady 触发同步。 */
  const pendingTiles = useRef<Map<string, Promise<LayerHandle>>>(new Map());
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const [mapReady, setMapReady] = useState(0);
  /* 文本图层依赖的 glyphs/sprite（style 级配置）。undefined 时地图以空样式
   * 先行创建；异步解析到后触发一次重建。 */
  const [glyphsUrl, setGlyphsUrl] = useState<{ glyphs?: string; sprite?: string }>({});
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

  /* 底图显隐（2.20.0）：每幅独立（未记录默认可见）；透明度仍整组统一。 */
  const [baseVisibility, setBaseVisibility] = useState<Record<string, boolean>>({});

  /* 地图初始化（Mapbox GL，Mercator；度坐标系服务由服务端重投影出图）。
   * 首个服务的 glyphs/sprite 在建图时声明（style 级配置，v1 建后不可改）。 */
  useEffect(() => {
    if (!config?.configured || !containerRef.current || mapRef.current) {
      return;
    }
    let cancelled = false;
    const el = containerRef.current;
    const inst = handlesRef.current;
    const baseInst = baseHandlesRef.current;
    const fittedSet = fitted.current;
    const [cx, cy] = config.center.length ? config.center : [0, 0];
    /* 无效中心（未配置 [0,0]、iServer 未配的 [0,-90] 等）回落默认——Leaflet
     * 时代的四川全省视野（2026-09-29 用户指定）。lng=0 或 lat=0 的配置视为
     * 垃圾值（会把地图带到几内亚湾/赤道）。 */
    const centerValid =
      Math.abs(cx) > 1e-6 && Math.abs(cy) > 1e-6 && Math.abs(cx) <= 180 && Math.abs(cy) <= 90;
    /* Leaflet 时代 center=[lat,lng]；mapbox 是 [lng,lat]。 */
    const center: [number, number] = centerValid ? [cy, cx] : [104.0, 30.6];
    const zoom = centerValid && (config.zoom ?? 0) > 0 ? (config.zoom as number) : 7;
    /* 地图异步创建；全屏监听要随 effect cleanup 摘除（async IIFE 的返回值
     * 无人接收，不能靠它清理）。 */
    let removeFullscreenHook: (() => void) | null = null;

    (async () => {
      /* 建图不等待任何探测（探测慢时面板整片空白，实测）：以当前 glyphs
       * 状态立起画布。glyphs/sprite 是 style 级配置且 v1 建图后不可改——
       * 由独立探测 effect 异步解析（glyphsUrl 状态），解析到后地图重建一次
       * （deps 含 glyphsUrl），文本图层自此可加。 */
      const style = {
        version: 8 as const,
        sources: {},
        layers: [],
        ...(glyphsUrl.glyphs ? { glyphs: glyphsUrl.glyphs } : {}),
        ...(glyphsUrl.sprite ? { sprite: glyphsUrl.sprite } : {}),
      };
      const map = new mapboxgl.Map({
        container: el,
        style: style as never,
        center,
        zoom,
        /* 官方可视化示例同款：attributionControl 关闭。 */
        attributionControl: false,
      });
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');
      map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      /* 不用 iclient 的 Logo 控件：其类没有 onRemove，mapbox v1 的
       * map.remove() 不设防直接调用——glyphs 解析后重建地图时必炸（实测
       * "onRemove is not a function" 整面板崩到错误页）。 */
      /* 点要素弹窗：矢量数据层前 8 个属性（延续 Leaflet bindPopup 内容）。 */
      map.on('click', (e) => {
        const vectorKeys = layersRef.current
          .filter((l) => l.kind === 'vector' && l.visible)
          .map((l) => l.key);
        const ids = vectorKeys.flatMap((k) => inst.get(k)?.layers.map((x) => x.id) ?? []);
        if (!ids.length) {
          return;
        }
        const feats = map.queryRenderedFeatures(e.point, { layers: ids });
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
      /* 容器尺寸随布局/全屏变化时引擎需显式重算（建图早于布局定型时画布
       * 会停在初始尺寸，实测卡在 300px 条）；ResizeObserver 覆盖所有来源
       * （含全屏），比单一 fullscreenchange 监听全面。 */
      const ro = new ResizeObserver(() => map.resize());
      ro.observe(el);
      removeFullscreenHook = () => ro.disconnect();
      mapRef.current = map;
      /* addSource/addLayer 必须等 style 就绪，否则 "Style is not done
       * loading"（实测）。mapReady 只在 load 后置位——各同步 effect 以此
       * 为闸，此前的一切改 style 操作都不会发生。 */
      map.on('load', () => {
        if (!cancelled) {
          setMapReady((n) => n + 1);
        }
      });
    })();

    return () => {
      cancelled = true;
      removeFullscreenHook?.();
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      baseInst.clear();
      inst.clear();
      fittedSet.clear();
    };
    // basemapEntries 变化即换底图组（与 Leaflet 版语义一致）；glyphsUrl 解析
    // 到值时重建一次（文本图层依赖 style 级 glyphs）
  }, [config, glyphsUrl]);

  /* glyphs 解析（非阻塞，不挡建图）：在底图组 + 已配置瓦片图层里找第一个
   * vectorstyles 可出且带 glyphs 的服务。结果置入 glyphsUrl → 地图重建。 */
  const glyphCandidatesKey = [
    ...basemapEntries.map((b) => b.url ?? ''),
    ...layers.filter((l) => l.kind === 'tiled').map((l) => l.url ?? ''),
  ].join('|');
  useEffect(() => {
    let probeCancelled = false;
    (async () => {
      for (const u of glyphCandidatesKey.split('|')) {
        if (!u) {
          continue;
        }
        const s = await getVectorStyle(u);
        if (probeCancelled) {
          return;
        }
        if (s?.glyphs) {
          setGlyphsUrl((prev) =>
            prev.glyphs === s.glyphs ? prev : { glyphs: s.glyphs, sprite: s.sprite },
          );
          return;
        }
      }
    })();
    return () => {
      probeCancelled = true;
    };
  }, [glyphCandidatesKey]);

  const baseLayer = layers.find((l) => l.kind === 'base');

  /* 底图同步：每幅一个句柄（vectorstyles 优先、栅格回落），显隐/透明度跟随。
   * mapReady=0 表示 style 未 load，改 style 会抛错——闸住。 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }
    basemapEntries.forEach((b, i) => {
      if (!b.url) {
        return;
      }
      const key = `base:${i}`;
      const visible = baseVisibility[b.name] ?? true;
      const opacity = baseLayer?.opacity ?? 1;
      const existing = baseHandlesRef.current.get(key);
      if (!existing) {
        let creating = pendingTiles.current.get(key);
        if (!creating) {
          creating = (async () => {
            const style = await getVectorStyle(b.url as string);
            return style
              ? addVectorHandle(map, key, style)
              : addRasterHandle(map, key, b.url as string);
          })();
          pendingTiles.current.set(key, creating);
        }
        creating
          .then(async (handle) => {
            pendingTiles.current.delete(key);
            if (mapRef.current !== map) {
              return;
            }
            baseHandlesRef.current.set(key, handle);
            setMapReady((n) => n + 1);
            if (handle.kind !== 'raster' || !b.url) {
              return;
            }
            /* 栅格 sanity 判断（用户定的原则：是否可用要判断）：取配置中心
             * 附近两张不同瓦片做摘要，逐字节相同 = 服务端 zxyTileImage 异常
             * （5.212 dom 实测如此：忽略 x/y 恒回同一图），明示换底图而非
             * 默默铺坏瓦片。中心保证在服务范围内，避开出界空瓦片误判。 */
            const [cfgLat, cfgLng] = config?.center?.length ? config.center : [0, 0];
            const cfgValid = Math.abs(cfgLat) + Math.abs(cfgLng) > 1e-6;
            const lng = cfgValid ? cfgLng : 104.0;
            const lat = cfgValid ? cfgLat : 30.6;
            const z = Math.min(10, Math.max(3, Math.round(config?.zoom ?? 7) + 1));
            const n = 2 ** z;
            const tx = Math.floor(((lng + 180) / 360) * n);
            const latRad = (lat * Math.PI) / 180;
            const ty = Math.max(
              0,
              Math.min(
                n - 1,
                Math.floor(
                  ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
                ),
              ),
            );
            const [d1, d2] = await Promise.all([
              rasterTileDigest(b.url, z, tx, ty),
              rasterTileDigest(b.url, z, Math.min(n - 1, tx + 2), ty),
            ]);
            if (d1 && d2 && d1 === d2) {
              /* 服务端忽略 x/y（5.212 老 iServer 无 3857 网格能力，多形式探
               * 测证实）——铺出来只会是全球同一张图，摘掉并以提示代替。 */
              removeHandle(map, handle);
              baseHandlesRef.current.delete(key);
              setNotice(
                `底图「${b.name || '底图'}」的栅格服务不支持 MapboxGL 出图（不同瓦片返回相同内容），请在底图管理切换（如北京大屏地图）`,
              );
            }
          })
          .catch((error) => {
            pendingTiles.current.delete(key);
            /* 单幅底图异常只影响自身，不塌面板 */
            console.warn('[MapBrowser] 底图创建失败:', b.name || i, error);
          });
        return;
      }
      try {
        setHandleVisible(map, existing, visible);
        applyHandleStyle(map, existing, { opacity });
      } catch (error) {
        console.warn('[MapBrowser] 底图同步失败:', b.name || i, error);
      }
    });
  }, [basemapEntries, baseVisibility, baseLayer, mapReady, config]);

  /* 瓦片图层同步：增删/显隐/透明度（vectorstyles 可用即矢量瓦片，否则栅格）。 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }
    const handles = handlesRef.current;
    const live = new Set(layers.map((l) => l.key));
    for (const [key, handle] of [...handles.entries()]) {
      if (!live.has(key)) {
        removeHandle(map, handle);
        handles.delete(key);
      }
    }
    layers.forEach((l) => {
      if (l.kind !== 'tiled' || !l.url) {
        return;
      }
      const key = l.key;
      const existing = handles.get(key);
      if (!existing) {
        /* 异步创建（探测 vectorstyles）pending 去重；落地前按最新 layers 校验
         * （创建期间可能已被删/换地图），属性由落地后的下次同步补齐。 */
        let creating = pendingTiles.current.get(key);
        if (!creating) {
          creating = (async () => {
            const style = await getVectorStyle(l.url as string);
            return style
              ? addVectorHandle(map, key, style)
              : addRasterHandle(map, key, l.url as string);
          })();
          pendingTiles.current.set(key, creating);
        }
        creating
          .then((handle) => {
            pendingTiles.current.delete(key);
            if (mapRef.current !== map) {
              return;
            }
            if (!layersRef.current.some((x) => x.key === key)) {
              return;
            }
            handles.set(key, handle);
            setMapReady((n) => n + 1);
          })
          .catch((error) => {
            pendingTiles.current.delete(key);
            console.warn('[MapBrowser] 图层创建失败:', l.name, error);
          });
        return;
      }
      /* 单个坏图层只影响自身：同步失败摘除句柄，下次同步重建。 */
      try {
        setHandleVisible(map, existing, l.visible);
        applyHandleStyle(map, existing, { opacity: l.opacity });
      } catch (error) {
        console.warn('[MapBrowser] 图层同步失败:', l.name, error);
        removeHandle(map, existing);
        handles.delete(key);
      }
    });
  }, [layers, mapReady]);

  /* 矢量图层同步：有要素才建层；数据更新走 setData 原地替换（免摘挂）。
   * 首次挂载自动 fitBounds，之后刷新重查保持当前视野（fitted 集合）。 */
  const prevFeaturesRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }
    const handles = handlesRef.current;
    for (const l of layers) {
      if (l.kind !== 'vector') {
        continue;
      }
      const data = features[l.key];
      const handle = handles.get(l.key);
      if (!handle) {
        if (!data) {
          continue;
        }
        if (!(data as { features?: unknown[] }).features?.length) {
          continue;
        }
        const created = addGeojsonHandle(map, l.key, data, l.color);
        handles.set(l.key, created);
        if (!fitted.current.has(l.key)) {
          const b = geojsonBounds(data);
          if (b) {
            map.fitBounds(
              [
                [b[0], b[1]],
                [b[2], b[3]],
              ],
              {
                padding: 16,
                maxZoom: 16,
                duration: 0,
              },
            );
          }
          fitted.current.add(l.key);
        }
        setHandleVisible(map, created, l.visible);
        applyHandleStyle(map, created, { opacity: l.opacity, color: l.color });
        continue;
      }
      if (!l.visible || !data) {
        setHandleVisible(map, handle, false);
        continue;
      }
      setHandleVisible(map, handle, true);
      applyHandleStyle(map, handle, { opacity: l.opacity, color: l.color });
      if (data !== prevFeaturesRef.current[l.key]) {
        const src = map.getSource(handle.sourceIds[0]);
        if (src && 'setData' in src) {
          (src as unknown as { setData: (data: unknown) => void }).setData(data);
        }
      }
    }
    prevFeaturesRef.current = features;
  }, [layers, features, mapReady]);

  /* 叠放次序同步（图层树拖拽）：数组序 = 绘制序（数组末 = 树顶 = 地图最上层）。
   * mapbox 按 style 声明序绘制：按数组序逐层 moveLayer 压顶即可（含隐藏层，
   * 不影响；显隐/样式变化不改 stamp 不触发）。 */
  const orderStampRef = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }
    const stamp = layers.map((l) => l.key).join('|');
    if (stamp === orderStampRef.current) {
      return;
    }
    orderStampRef.current = stamp;
    for (const l of layers) {
      if (l.kind === 'base') {
        continue;
      }
      const handle = handlesRef.current.get(l.key);
      if (!handle) {
        continue;
      }
      for (const { id } of handle.layers) {
        try {
          map.moveLayer(id);
        } catch {
          /* 图层尚未落地：忽略 */
        }
      }
    }
  }, [layers, mapReady]);

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

  /** 瓦片图层强制重取（刷新按钮）：摘除句柄与 pending，同步 effect 重建。 */
  const recreateHandle = (key: string) => {
    const map = mapRef.current;
    const handle = handlesRef.current.get(key);
    if (map && handle) {
      removeHandle(map, handle);
      handlesRef.current.delete(key);
    }
    pendingTiles.current.delete(key);
    setMapReady((n) => n + 1);
  };

  /** 刷新（图层树按钮）：矢量层按当前地图范围重查，瓦片层强制重取。 */
  const refreshLayers = () => {
    const map = mapRef.current;
    const bbox = map ? mapBbox(map) : undefined;
    for (const l of layers) {
      if (l.kind === 'vector' && l.regId) {
        void fetchFeatures(l.key, l.regId, false, bbox);
      } else if (l.kind === 'tiled') {
        recreateHandle(l.key);
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
    const b = geojsonBounds(features[l.key]);
    if (b) {
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: 16, maxZoom: 16, duration: 0 },
      );
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
              /* mapbox-gl.css 的 .mapboxgl-map{position:relative} 与 .absolute
               * 同特异性，懒加载 chunk 的样式表在后必胜——实测容器塌成 2px
               * 高、地图视口为空。内联样式兜底，任何构建序下都成立。 */
              style={{ position: 'absolute', inset: 0 }}
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
