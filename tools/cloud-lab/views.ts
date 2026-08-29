// 雲の実験環境で表示できる量の表。並びがそのまま画面のボタンの並びで、構成の上流(気候の事前分布)から
// 下流(雲)へ並ぶ。各ビューは、天気のモデルのグラフ・気候の事前分布・雲の場の写しから、
// 表示値 0..1 の色を組む。
import { length, screenUV, texture, vec3 } from 'three/tsl';
import { directionFromEquirectUv } from '../../src/render/cloud/sphere-frame';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { CloudFieldTextures } from '../../src/render/cloud/cloud-field-textures';
import type { WeatherModel } from '../../src/render/cloud/weather-model';
import type { Vec2Node, Vec3Node, Vec4Node } from '../../src/render/tsl-types';

export type CloudLabViewId =
  | 'elevation' | 'meanTemperature' | 'meanCloudiness'
  | 'pressure' | 'wind' | 'convergence' | 'lift' | 'temperature'
  | 'humiditySource' | 'upperHumiditySource' | 'humidity' | 'upperHumidity'
  | 'opaque' | 'opaqueByAltitude' | 'translucent';

export type CloudLabView = {
  readonly id: CloudLabViewId;
  readonly label: string;
  // 雲の場の写しを読むビューだけが true。false のビューでは写しを焼かない — 焼くと 2048×1024
  // 全面ぶんの天気の評価が、画面に出ないまま捨てられる。
  readonly readsFields: boolean;
  readonly color: (model: WeatherModel, climate: ClimateMap, fields: CloudFieldTextures) => Vec3Node;
};

// 表示値 0..1 へ写すときの目盛り。不透明雲の光学的厚みは 0..32(高度別は低・中・高の 3 群を RGB に)、
// 薄い雲は 0..1.5、気圧は −70..+30 hPa、収束は ±2e-4 /s を 0.5 中心に、上昇流は ±0.1 m/s を
// 0.5 中心に、温度は −50..50 °C、風は ±40 m/s を 0.5 中心の R(東)G(北)に、速さを B に、
// 標高は 0..8000 m。
const OPAQUE_SPAN = 32;
const TRANSLUCENT_SPAN = 1.5;
const PRESSURE_MIN = -70;
const PRESSURE_SPAN = 100;
const CONVERGENCE_SPAN = 2e-4;
const LIFT_SPAN = 0.1;
const TEMPERATURE_MIN = -50;
const TEMPERATURE_SPAN = 100;
const WIND_SPAN = 40;
const ELEVATION_SPAN = 8000;

// 画面の texel に当たる単位方向。
const direction = directionFromEquirectUv(screenUV);

// 風 [m/s] の東・北成分を 0.5 中心の RG に、速さを B に。
function windColor(wind: Vec2Node): Vec3Node {
  return vec3(wind.x.div(2 * WIND_SPAN).add(0.5), wind.y.div(2 * WIND_SPAN).add(0.5), length(wind).div(WIND_SPAN));
}

// 不透明雲のスラブ 0..3 と 4..7 の光学的厚み。
function slabs(fields: CloudFieldTextures): [Vec4Node, Vec4Node] {
  return [texture(fields.opaqueLowTexture, screenUV), texture(fields.opaqueHighTexture, screenUV)];
}

export const CLOUD_LAB_VIEWS: readonly CloudLabView[] = [
  { id: 'elevation', label: '標高', readsFields: false, color: (_m, climate) => vec3(climate.elevation(direction).div(ELEVATION_SPAN)) },
  { id: 'meanTemperature', label: '平均気温', readsFields: false, color: (_m, climate) => vec3(climate.meanTemperature(direction).sub(TEMPERATURE_MIN).div(TEMPERATURE_SPAN)) },
  { id: 'meanCloudiness', label: '平年の雲量', readsFields: false, color: (_m, climate) => vec3(climate.meanCloudiness(direction)) },
  { id: 'pressure', label: '気圧', readsFields: false, color: (model) => vec3(model.weatherAt(direction).pressure.sub(PRESSURE_MIN).div(PRESSURE_SPAN)) },
  { id: 'wind', label: '風', readsFields: false, color: (model) => windColor(model.weatherAt(direction).wind) },
  { id: 'convergence', label: '収束', readsFields: false, color: (model) => vec3(model.weatherAt(direction).convergence.div(2 * CONVERGENCE_SPAN).add(0.5)) },
  { id: 'lift', label: '上昇流', readsFields: false, color: (model) => vec3(model.weatherAt(direction).lift.div(2 * LIFT_SPAN).add(0.5)) },
  { id: 'temperature', label: '温度', readsFields: false, color: (model) => vec3(model.weatherAt(direction).temperature.sub(TEMPERATURE_MIN).div(TEMPERATURE_SPAN)) },
  { id: 'humiditySource', label: '移流前の湿度', readsFields: false, color: (model) => vec3(model.humiditySourceAt(direction).x) },
  { id: 'upperHumiditySource', label: '移流前の上層湿度', readsFields: false, color: (model) => vec3(model.humiditySourceAt(direction).y) },
  { id: 'humidity', label: '湿度', readsFields: false, color: (model) => vec3(model.weatherAt(direction).humidity) },
  { id: 'upperHumidity', label: '上層湿度', readsFields: false, color: (model) => vec3(model.weatherAt(direction).upperHumidity) },
  { id: 'opaque', label: '不透明雲', readsFields: true, color: (_m, _c, fields) => {
    const [low, high] = slabs(fields);
    return vec3(low.r.add(low.g).add(low.b).add(low.a).add(high.r).add(high.g).add(high.b).add(high.a).div(OPAQUE_SPAN));
  } },
  { id: 'opaqueByAltitude', label: '不透明雲(高度別)', readsFields: true, color: (_m, _c, fields) => {
    const [low, high] = slabs(fields);
    return vec3(low.r.add(low.g).add(low.b), low.a.add(high.r).add(high.g), high.b.add(high.a)).div(OPAQUE_SPAN / 2);
  } },
  { id: 'translucent', label: '薄い雲', readsFields: true, color: (_m, _c, fields) => vec3(texture(fields.translucentTexture, screenUV).r.div(TRANSLUCENT_SPAN)) },
];

// 起動時に出す量。並びが上流から下流なので、既定は先頭ではなく最終出力。
export const DEFAULT_CLOUD_LAB_VIEW: CloudLabView = CLOUD_LAB_VIEWS.find((view) => view.id === 'opaque')!;
