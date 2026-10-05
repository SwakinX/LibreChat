/** 地图 GeoJSON 工具函数：MapBrowser（图层树）与 MapPanel（结果预览）共用。
 * features 状态兼容要素数组与 FeatureCollection 两种形态——统一归一后处理。 */

type MinimalFeature = { geometry?: { type?: string; coordinates?: unknown } | null };

export type MinimalFC = { type: 'FeatureCollection'; features: MinimalFeature[] };

export function normalizeFeatureCollection(data: unknown): MinimalFC {
  if (Array.isArray(data)) {
    return { type: 'FeatureCollection', features: data as never };
  }
  const fc = data as { type?: string; features?: MinimalFeature[] };
  if (fc?.type === 'FeatureCollection' && Array.isArray(fc.features)) {
    return fc as never;
  }
  return { type: 'FeatureCollection', features: [] };
}

/** features 状态里某图层的要素列表（数组/FeatureCollection 两形态）。 */
export function featureListOf(data: unknown): unknown[] | null {
  return normalizeFeatureCollection(data).features;
}

/** GeoJSON 中出现的几何大类（要素几何为 null/缺失时跳过）。 */
export function geometryKinds(data: unknown): { point: boolean; line: boolean; polygon: boolean } {
  const kinds = { point: false, line: false, polygon: false };
  for (const f of normalizeFeatureCollection(data).features) {
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
export function geojsonBounds(data: unknown): [number, number, number, number] | null {
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
  for (const f of normalizeFeatureCollection(data).features) {
    walk(f.geometry?.coordinates);
  }
  return w <= e && s <= n ? [w, s, e, n] : null;
}
