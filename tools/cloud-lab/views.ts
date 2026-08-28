// 雲の実験環境で表示できる量の表。並びがそのまま画面のボタンの並び。各ビューは、天気のモデルの
// グラフ・気候の事前分布・雲の場の写しから、表示値 0..1 の色を組む。
import { length, screenUV, texture, vec3 } from 'three/tsl';
import { directionFromEquirectUv } from '../../src/render/cloud/sphere-frame';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { CloudFieldTextures } from '../../src/render/cloud/cloud-field-textures';
import type { WeatherModel } from '../../src/render/cloud/weather-model';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';

export type CloudLabViewId =
  | 'opticalDepth' | 'cloudTop'
  | 'pressure' | 'convergence' | 'wind' | 'upperWind' | 'temperature' | 'humidity'
  | 'meanTemperature' | 'meanHumidity' | 'elevation';

export type CloudLabView = {
  readonly id: CloudLabViewId;
  readonly label: string;
  readonly color: (model: WeatherModel, climate: ClimateMap, fields: CloudFieldTextures) => Vec3Node;
};

// 表示値 0..1 へ写すときの目盛り。光学的厚みは 0..8、気圧は −40..+20 hPa、収束は ±2e-5 /s を
// 0.5 中心に、温度は −40..40 °C、風は ±40 m/s を 0.5 中心の R(東)G(北)に、速さを B に、
// 標高は 0..8000 m。
const OPTICAL_DEPTH_SPAN = 8;
const PRESSURE_MIN = -40;
const PRESSURE_SPAN = 60;
const CONVERGENCE_SPAN = 2e-5;
const TEMPERATURE_MIN = -40;
const TEMPERATURE_SPAN = 80;
const WIND_SPAN = 40;
const ELEVATION_SPAN = 8000;

// 画面の texel に当たる単位方向。
const direction = directionFromEquirectUv(screenUV);

// 風 [m/s] の東・北成分を 0.5 中心の RG に、速さを B に。
function windColor(wind: Vec2Node): Vec3Node {
  return vec3(wind.x.div(2 * WIND_SPAN).add(0.5), wind.y.div(2 * WIND_SPAN).add(0.5), length(wind).div(WIND_SPAN));
}

export const CLOUD_LAB_VIEWS: readonly CloudLabView[] = [
  { id: 'opticalDepth', label: '光学的厚み', color: (_m, _c, fields) => vec3(texture(fields.fieldTexture, screenUV).r.div(OPTICAL_DEPTH_SPAN)) },
  { id: 'cloudTop', label: '雲頂', color: (_m, _c, fields) => vec3(texture(fields.fieldTexture, screenUV).g) },
  { id: 'pressure', label: '気圧', color: (model) => vec3(model.weatherAt(direction).pressure.sub(PRESSURE_MIN).div(PRESSURE_SPAN)) },
  { id: 'convergence', label: '収束', color: (model) => vec3(model.weatherAt(direction).convergence.div(2 * CONVERGENCE_SPAN).add(0.5)) },
  { id: 'wind', label: '風', color: (model) => windColor(model.weatherAt(direction).wind) },
  { id: 'upperWind', label: '上層風', color: (model) => windColor(model.weatherAt(direction).upperWind) },
  { id: 'temperature', label: '温度', color: (model) => vec3(model.weatherAt(direction).temperature.sub(TEMPERATURE_MIN).div(TEMPERATURE_SPAN)) },
  { id: 'humidity', label: '湿度', color: (model) => vec3(model.weatherAt(direction).humidity) },
  { id: 'meanTemperature', label: '平均気温', color: (_m, climate) => vec3(climate.meanTemperature(direction).sub(TEMPERATURE_MIN).div(TEMPERATURE_SPAN)) },
  { id: 'meanHumidity', label: '平均湿度', color: (_m, climate) => vec3(climate.meanHumidity(direction)) },
  { id: 'elevation', label: '標高', color: (_m, climate) => vec3(climate.elevation(direction).div(ELEVATION_SPAN)) },
];
