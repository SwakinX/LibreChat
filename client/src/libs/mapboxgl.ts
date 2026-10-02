/* mapbox-gl-enhance 接入入口：组件从这里导入 mapboxgl，而不是直接导入
 * ./mapbox-gl-enhance。
 *
 * vite/rollup 打包会破坏增强库内联的 blob worker 脚本（矢量瓦片解析全在
 * worker 里，坏掉时控制台 "B is not defined"、矢量层全灭而栅格正常——栅格
 * 在主线程加载）。worker 改用原始文件：经 vite ?url 资产导入（构建必然
 * emit 并返回真实 URL，public/ 目录方案曾因文件未进 dist 而 404——worker
 * 拉不到时引擎 load 永不触发、整图静默空白且无任何报错）。 */
import enhanceWorkerUrl from './mapbox-gl-enhance.js?url';
import mapboxgl from './mapbox-gl-enhance';

(mapboxgl as unknown as { workerUrl: string }).workerUrl = enhanceWorkerUrl;

export default mapboxgl;
