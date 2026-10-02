/**
 * jest 桩：mapbox-gl 与 @supermapgis/iclient-mapboxgl 共用。
 *
 * 测试不触地图行为（无地图相关 spec），但套件的导入链会经组件传递进来，
 * 真库在 jsdom 里 import 期就访问 URL.createObjectURL/Worker 等浏览器 API
 * 会整组加载失败。这里只提供源码 import 期用到的名字，均为空实现。
 */
class Stub {}

const mapboxgl = {
  Map: class {
    on() {}
    addControl() {}
    remove() {}
  },
  Popup: Stub,
  NavigationControl: Stub,
  ScaleControl: Stub,
  LngLatBounds: Stub,
};

module.exports = { __esModule: true, default: mapboxgl, mapboxgl, Logo: Stub };
