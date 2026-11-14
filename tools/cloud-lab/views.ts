// 雲の実験環境で表示できる量の表。並びがそのまま画面のボタンの並びで、構成の上流(気候の事前分布)から
// 下流(雲)へ並ぶ。各ビューは表示値 0..1 の色を組み、その材料が天気のモデルなのか雲の写しなのかで
// 2 種類に分かれる。
import { exp, float, length, select, texture, vec3 } from 'three/tsl';
import { equirectUvFromDirection } from '../../src/render/field-projection';
import { CUMULUS_TOP_ALTITUDE } from '../../src/render/cloud/cloud-kind';
import { cirrusFlowColor } from './cirrus-flow-color';
import {
  cirrusColumnOpticalDepthNode, cirrusTopAltitudeNode, cumulusOpacityNode, cumulusTopAltitudeNode,
} from '../../src/render/cloud/cloud-kind-node';
import type * as THREE from 'three/webgpu';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { CloudSample } from '../../src/render/cloud/cloud-field-sample';
import type { WeatherModel } from '../../src/render/cloud/weather-model';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';

export type CloudLabViewId =
  | 'elevation' | 'landFraction' | 'meanCloudiness' | 'meanWind'
  | 'pressure' | 'surfaceWind' | 'traceWind' | 'front' | 'airMass' | 'lift'
  | 'surfaceHumiditySource' | 'upperHumiditySource' | 'convectionSource'
  | 'surfaceHumidity' | 'upperHumidity' | 'convection' | 'convectiveActivity' | 'convectiveDepth'
  | 'cumulus' | 'cirrus' | 'coverage' | 'cloudTop' | 'cirrusTop' | 'translucent' | 'cirrusFlow'
  | 'composite' | 'photo';

// reads が 'weather' のビューは天気のモデルと気候の事前分布から直に、'cloud' のビューは焼いた雲の
// 写しを描画と同じ読み取りで読んで色を組む。'photo' のビューは実写の雲テクスチャを読むだけで、生成の系には
// 触れない — 生成と同じ図法・同じ解像度で実写を出し、他のビューと切り替えて見比べるためにある。
// 雲場を単位方向で読む口。面は自分の投影の uv で直に読む。
type CloudAt = (direction: Vec3Node) => CloudSample;

export type CloudLabView = {
  readonly id: CloudLabViewId;
  readonly label: string;
} & (
  | { readonly reads: 'weather'; readonly color: (d: Vec3Node, model: WeatherModel, climate: ClimateMap) => Vec3Node }
  | { readonly reads: 'cloud'; readonly color: (d: Vec3Node, cloudAt: CloudAt) => Vec3Node }
  | { readonly reads: 'photo'; readonly color: (d: Vec3Node, photo: THREE.Texture) => Vec3Node }
);

// 表示値 0..1 へ写すときの目盛り。雲頂高度は積雲の上端高度まで、巻雲の光学的厚みは 0..1、気圧は
// −70..+30 hPa、上昇流は ±0.1 m/s を、対流は ±0.5 をそれぞれ 0.5 中心に、対流の峰(対流 × 活発度、
// 塔が立つかどうかを決める量)は 0..0.3、前線(気団の圧縮の 1 を超えた分)は 0..8、
// 暖気の流入は ±0.4 rad(48 h の追跡で気団が動く緯度差の上限)を 0.5 中心に、
// 風は ±45 m/s(台風の芯の風速まで飽和させない幅)を
// 0.5 中心の R(東)G(北)に、速さを B に、標高は 0..8000 m。
// 雲の量・不透明度・湿度・対流の活発度はそのまま出す。**地表の風・平均風・追跡の風は同じ目盛りに乗せる** — 大循環が
// 運ぶ分と、気圧から出る分と、気団を遡らせる分の大きさを見比べるため。
const CONVECTION_SPAN = 0.5;
const CONVECTIVE_DEPTH_SPAN = 0.3;
const TRANSLUCENT_SPAN = 1;
const PRESSURE_MIN = -70;
const PRESSURE_SPAN = 100;
const LIFT_SPAN = 0.1;
const FRONT_SPAN = 8;
const WARMTH_SPAN = 0.4;
const WIND_SPAN = 45;
const ELEVATION_SPAN = 8000;

// 風 [m/s] の東・北成分を 0.5 中心の RG に、速さを B に。
function windColor(wind: Vec2Node): Vec3Node {
  return vec3(wind.x.div(2 * WIND_SPAN).add(0.5), wind.y.div(2 * WIND_SPAN).add(0.5), length(wind).div(WIND_SPAN));
}

export const CLOUD_LAB_VIEWS: readonly CloudLabView[] = [
  { id: 'elevation', label: '標高', reads: 'weather',
    color: (d, _model, climate) => vec3(climate.elevation(d).div(ELEVATION_SPAN)) },
  { id: 'landFraction', label: '陸らしさ', reads: 'weather',
    color: (d, _model, climate) => vec3(climate.landFraction(d)) },
  { id: 'meanCloudiness', label: '平年の雲量', reads: 'weather',
    color: (d, _model, climate) => vec3(climate.meanCloudiness(d)) },
  { id: 'meanWind', label: '平均風', reads: 'weather',
    color: (d, model) => windColor(model.meanWindAt(d)) },
  { id: 'pressure', label: '気圧', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).pressure.sub(PRESSURE_MIN).div(PRESSURE_SPAN)) },
  { id: 'surfaceWind', label: '地表の風', reads: 'weather',
    color: (d, model) => windColor(model.weatherAt(d).surfaceWind) },
  { id: 'traceWind', label: '追跡の風', reads: 'weather',
    color: (d, model) => windColor(model.traceWindAt(d)) },
  { id: 'front', label: '前線', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).compression.sub(1).div(FRONT_SPAN)) },
  { id: 'airMass', label: '気団', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).warmth.div(2 * WARMTH_SPAN).add(0.5)) },
  { id: 'lift', label: '上昇流', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).lift.div(2 * LIFT_SPAN).add(0.5)) },
  { id: 'surfaceHumiditySource', label: '移流前の地表の湿度', reads: 'weather',
    color: (d, model) => vec3(model.humiditySourceAt(d).x) },
  { id: 'upperHumiditySource', label: '移流前の上層の湿度', reads: 'weather',
    color: (d, model) => vec3(model.humiditySourceAt(d).y) },
  { id: 'convectionSource', label: '移流前の対流', reads: 'weather',
    color: (d, model) => vec3(model.convectionSourceAt(d).y.div(2 * CONVECTION_SPAN).add(0.5)) },
  { id: 'surfaceHumidity', label: '地表の湿度', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).surfaceHumidity) },
  { id: 'upperHumidity', label: '上層の湿度', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).upperHumidity) },
  { id: 'convection', label: '対流', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).convection.y.div(2 * CONVECTION_SPAN).add(0.5)) },
  { id: 'convectiveActivity', label: '対流の活発度', reads: 'weather',
    color: (d, model) => vec3(model.weatherAt(d).convectiveActivity) },
  { id: 'convectiveDepth', label: '対流の峰', reads: 'weather',
    color: (d, model) => {
      const weather = model.weatherAt(d);
      return vec3(weather.convection.y.mul(weather.convectiveActivity).div(CONVECTIVE_DEPTH_SPAN));
    } },
  { id: 'cumulus', label: '積雲の量', reads: 'cloud',
    color: (d, cloudAt) => vec3(cloudAt(d).cumulus) },
  { id: 'cirrus', label: '巻雲の量', reads: 'cloud',
    color: (d, cloudAt) => vec3(cloudAt(d).cirrus) },
  { id: 'coverage', label: '積雲の不透明度', reads: 'cloud',
    color: (d, cloudAt) => vec3(cumulusOpacityNode(cloudAt(d).cumulus)) },
  { id: 'cloudTop', label: '積雲の雲頂', reads: 'cloud',
    color: (d, cloudAt) => vec3(cumulusTopAltitudeNode(cloudAt(d).cumulus).div(CUMULUS_TOP_ALTITUDE)) },
  // 巻雲の量が 0 の所は雲そのものが無いので、高さも 0 へ落とす。
  { id: 'cirrusTop', label: '巻雲の雲頂', reads: 'cloud',
    color: (d, cloudAt) => {
      const cloud = cloudAt(d);
      return vec3(select(cloud.cirrus.greaterThan(0),
        cirrusTopAltitudeNode(cloud.cirrus).div(CUMULUS_TOP_ALTITUDE), float(0)));
    } },
  { id: 'translucent', label: '巻雲の厚み', reads: 'cloud',
    color: (d, cloudAt) => vec3(cirrusColumnOpticalDepthNode(cloudAt(d).cirrus).div(TRANSLUCENT_SPAN)) },
  // 巻雲の筋の向きを色相、揃い度を明度で。揃い度の無い所は黒。
  { id: 'cirrusFlow', label: '巻雲の筋の向き', reads: 'cloud',
    color: (d, cloudAt) => cirrusFlowColor(cloudAt(d).cirrusFlow) },
  // 積雲と巻雲を 1 枚に重ねた見え。晴れた空が透ける割合 (1 − 不透明度)·e^(−τ) の補で、
  // 加算と違って飽和しない。実写と見比べるための面で、描画側の合成の仕様ではない。
  { id: 'composite', label: '合成', reads: 'cloud',
    color: (d, cloudAt) => {
      const cloud = cloudAt(d);
      const clear = cumulusOpacityNode(cloud.cumulus).oneMinus()
        .mul(exp(cirrusColumnOpticalDepthNode(cloud.cirrus).negate()));
      return vec3(clear.oneMinus());
    } },
  { id: 'photo', label: '実写', reads: 'photo',
    color: (d, photo) => texture(photo, equirectUvFromDirection(d)).rgb },
];

// 起動時に出す量。並びが上流から下流なので、既定は先頭ではなく最終出力。
export const DEFAULT_CLOUD_LAB_VIEW: CloudLabView = CLOUD_LAB_VIEWS.find((view) => view.id === 'coverage')!;
