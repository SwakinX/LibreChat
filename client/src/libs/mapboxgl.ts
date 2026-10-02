/* mapbox-gl-enhance 接入入口：组件从这里导入 mapboxgl，而不是直接导入
 * ./mapbox-gl-enhance。
 *
 * vite/rollup 打包会破坏增强库内联的 blob worker 脚本（矢量瓦片解析全在
 * worker 里，坏掉时控制台 "B is not defined"、矢量层全灭而栅格正常——栅格
 * 在主线程加载）。这里把 worker 指向 public 下的原始未打包副本（与打包
 * 副本同版本），官方示例页加载原始文件即无此问题。 */
import mapboxgl from './mapbox-gl-enhance';

(mapboxgl as unknown as { workerUrl: string }).workerUrl = '/libs/mapbox-gl-enhance.js';

export default mapboxgl;
