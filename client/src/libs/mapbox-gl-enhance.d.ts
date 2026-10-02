/* SuperMap mapbox-gl-enhance（mapbox-gl 1.12.1-7 定制构建，内置 CRS 度网格
 * 支持）。运行时实现为同目录 .js（UMD，default 导出 mapboxgl 命名空间）；
 * 类型沿用 @types/mapbox-gl v1 声明，增强版新增的 Map 选项（crs 等）在
 * 调用处显式断言。 */
declare const mapboxgl: typeof import('mapbox-gl');
export default mapboxgl;

/* vite 资产导入（workerUrl 用）：?url 后缀返回 emit 后的运行时 URL。 */
declare module '*.js?url' {
  const src: string;
  export default src;
}
