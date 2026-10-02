/* mapbox-gl-enhance 加载器：组件经 `await ensureMapboxGL()` 取引擎。
 *
 * 为什么用运行时 <script> 而不是 vite import：增强库是三段 chunk 按顺序
 * 拼接的敏感结构（文件头自述 "rely on the order they're imported"），
 * 经打包器处理会破坏内联 worker 字符串（实测 "B is not defined"、矢量
 * 瓦片全灭）；整文件当 workerUrl 也跑不起来（其顶层引用 window，worker
 * 环境未定义——实测）。官方页面即以 <script> 原样加载（include-mapboxgl
 * 同款），内联 worker 保持原始、开箱可用。
 */
let loading: Promise<MapboxGLNamespace> | null = null;

type MapboxGLNamespace = typeof import('mapbox-gl');

export function ensureMapboxGL(): Promise<MapboxGLNamespace> {
  if (!loading) {
    loading = new Promise<MapboxGLNamespace>((resolve, reject) => {
      const w = window as unknown as { mapboxgl?: MapboxGLNamespace };
      if (w.mapboxgl) {
        resolve(w.mapboxgl);
        return;
      }
      const script = document.createElement('script');
      script.src = '/libs/mapbox-gl-enhance.js';
      script.onload = () => {
        if (w.mapboxgl) {
          resolve(w.mapboxgl);
        } else {
          reject(new Error('mapbox-gl-enhance 加载后未挂载 window.mapboxgl'));
        }
      };
      script.onerror = () => reject(new Error('mapbox-gl-enhance 脚本加载失败'));
      document.head.appendChild(script);
    });
  }
  return loading;
}
