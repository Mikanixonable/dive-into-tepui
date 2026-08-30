// 雲の実験環境で表示できる量の表。並びがそのまま画面のボタンの並びで、構成の上流(気候の事前分布)から
// 下流(雲)へ並ぶ。各ビューは、単位方向・天気のモデルのグラフ・気候の事前分布・雲の場の写しから、
// 表示値 0..1 の色を組む。
import { length, vec3 } from 'three/tsl';
import type { BakedField } from '../../src/render/cloud/baked-field';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { WeatherModel } from '../../src/render/cloud/weather-model';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';

export type CloudLabViewId =
  | 'elevation' | 'meanCloudiness'
  | 'pressure' | 'wind' | 'lift'
  | 'humiditySource' | 'upperHumiditySource' | 'humidity' | 'upperHumidity'
  | 'opaque' | 'translucent';

export type CloudLabView = {
  readonly id: CloudLabViewId;
  readonly label: string;
  // 雲の場の写しを読むビューだけが true。false のビューでは写しを焼かない — 焼くと写し全面ぶんの
  // 天気の評価が、画面に出ないまま捨てられる。
  readonly readsCloud: boolean;
  readonly color: (
    direction: Vec3Node, model: WeatherModel, climate: ClimateMap, cloud: BakedField) => Vec3Node;
};

// 表示値 0..1 へ写すときの目盛り。不透明雲の光学的厚みは 0..4(そこで下地が 98% 隠れる)、
// 薄い雲は 0..1、気圧は −70..+30 hPa、上昇流は ±0.1 m/s を 0.5 中心に、風は ±50 m/s(モデルの
// 頭打ちと同じ)を 0.5 中心の R(東)G(北)に、速さを B に、標高は 0..8000 m。
const OPAQUE_SPAN = 4;
const TRANSLUCENT_SPAN = 1;
const PRESSURE_MIN = -70;
const PRESSURE_SPAN = 100;
const LIFT_SPAN = 0.1;
const WIND_SPAN = 50;
const ELEVATION_SPAN = 8000;

// 風 [m/s] の東・北成分を 0.5 中心の RG に、速さを B に。
function windColor(wind: Vec2Node): Vec3Node {
  return vec3(wind.x.div(2 * WIND_SPAN).add(0.5), wind.y.div(2 * WIND_SPAN).add(0.5), length(wind).div(WIND_SPAN));
}

export const CLOUD_LAB_VIEWS: readonly CloudLabView[] = [
  { id: 'elevation', label: '標高', readsCloud: false, color: (d, _m, climate) => vec3(climate.elevation(d).div(ELEVATION_SPAN)) },
  { id: 'meanCloudiness', label: '平年の雲量', readsCloud: false, color: (d, _m, climate) => vec3(climate.meanCloudiness(d)) },
  { id: 'pressure', label: '気圧', readsCloud: false, color: (d, model) => vec3(model.weatherAt(d).pressure.sub(PRESSURE_MIN).div(PRESSURE_SPAN)) },
  { id: 'wind', label: '風', readsCloud: false, color: (d, model) => windColor(model.weatherAt(d).wind) },
  { id: 'lift', label: '上昇流', readsCloud: false, color: (d, model) => vec3(model.weatherAt(d).lift.div(2 * LIFT_SPAN).add(0.5)) },
  { id: 'humiditySource', label: '移流前の湿度', readsCloud: false, color: (d, model) => vec3(model.humiditySourceAt(d).x) },
  { id: 'upperHumiditySource', label: '移流前の上層湿度', readsCloud: false, color: (d, model) => vec3(model.humiditySourceAt(d).y) },
  { id: 'humidity', label: '湿度', readsCloud: false, color: (d, model) => vec3(model.weatherAt(d).humidity) },
  { id: 'upperHumidity', label: '上層湿度', readsCloud: false, color: (d, model) => vec3(model.weatherAt(d).upperHumidity) },
  { id: 'opaque', label: '不透明雲', readsCloud: true, color: (d, _m, _c, cloud) => vec3(cloud.at(d).r.div(OPAQUE_SPAN)) },
  { id: 'translucent', label: '薄い雲', readsCloud: true, color: (d, _m, _c, cloud) => vec3(cloud.at(d).g.div(TRANSLUCENT_SPAN)) },
];

// 起動時に出す量。並びが上流から下流なので、既定は先頭ではなく最終出力。
export const DEFAULT_CLOUD_LAB_VIEW: CloudLabView = CLOUD_LAB_VIEWS.find((view) => view.id === 'opaque')!;
