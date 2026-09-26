// 雲の実験環境で表示できる量の表。並びがそのまま画面のボタンの並びで、構成の上流(気候の
// 事前分布)から下流(雲)へ並ぶ。各ビューは表示値 0..1 の色を組み、その材料で分かれる:
// 'climate' は気候の事前分布、'wind' は大気風モデル、'diagnostic' は新経路が実際に読む
// 総観規模の天気と環境プロファイル(weatherAtCpu・環境攪乱を equirect へ焼いたもの)、
// 'mass' は供給が届いた層別質量の列合計、'cloud' は焼いた雲の写し、'photo' は実写。
import { exp, float, length, texture, vec2, vec3 } from 'three/tsl';
import { equirectUvFromDirection } from '../../src/render/field-projection';
import { latitudeOf } from '../../src/render/cloud/sphere-frame';
import { SURFACE_HEIGHT } from '../../src/render/cloud/atmospheric-wind';
import type { AtmosphericWindField } from '../../src/render/cloud/atmospheric-wind';
import type * as THREE from 'three/webgpu';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { CloudSample } from '../../src/render/cloud/cloud-field-sample';
import type { GlobalDiagnosticSample, GlobalMassSample } from './global-field';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';

export type CloudLabViewId =
  | 'elevation' | 'landFraction' | 'meanCloudiness' | 'meanWind'
  | 'pressure' | 'surfaceWind' | 'front' | 'band' | 'airMass' | 'lift' | 'anvil'
  | 'cape' | 'cloudBase' | 'upperMoisture' | 'waterVapor' | 'latentFlux'
  | 'liquidMass' | 'iceMass'
  | 'coverage' | 'cloudTop' | 'translucent' | 'composite' | 'photo';

// 雲場を単位方向で読む口。面は自分の投影の uv で直に読む。
export type CloudAt = (direction: Vec3Node) => CloudSample;

export type CloudLabView = {
  readonly id: CloudLabViewId;
  readonly label: string;
} & (
  | { readonly reads: 'climate'; readonly color: (d: Vec3Node, climate: ClimateMap) => Vec3Node }
  | { readonly reads: 'wind'; readonly color: (d: Vec3Node, wind: AtmosphericWindField) => Vec3Node }
  | {
      readonly reads: 'diagnostic';
      readonly color: (d: Vec3Node, diag: GlobalDiagnosticSample) => Vec3Node;
    }
  | { readonly reads: 'mass'; readonly color: (d: Vec3Node, mass: GlobalMassSample) => Vec3Node }
  | { readonly reads: 'cloud'; readonly color: (d: Vec3Node, cloudAt: CloudAt) => Vec3Node }
  | { readonly reads: 'photo'; readonly color: (d: Vec3Node, photo: THREE.Texture) => Vec3Node }
);

// 表示値 0..1 へ写すときの目盛り。雲頂高度は 0..15000 m、薄い雲の光学的厚みは 0..1、気圧の
// 偏差は −70..+30 hPa、上昇流は ±0.1 m/s を 0.5 中心に、前線(気団の圧縮の 1 を超えた分)は
// 0..8、暖気の流入は ±0.4 rad を 0.5 中心に、風は ±45 m/s(台風の芯の風速まで飽和させない幅)
// を 0.5 中心の R(東)G(北)に速さを B に、標高は 0..8000 m、CAPE は 0..3000 J/kg、
// 雲底は 0..5000 m、可降水量は 0..60 kg/m²、潜熱フラックスは 0..200 W/m²、層別質量の列合計は
// 液水・氷とも 0..0.05 kg/m²(全球格子の列質量は 0.01〜0.04 kg/m² の桁)。被覆率・気団の
// 折り目・金床・上層の湿りはそのまま出す。
const CLOUD_TOP_SPAN = 15000;
const TRANSLUCENT_SPAN = 1;
const PRESSURE_MIN = -70;
const PRESSURE_SPAN = 100;
const LIFT_SPAN = 0.1;
const FRONT_SPAN = 8;
const WARMTH_SPAN = 0.4;
const WIND_SPAN = 45;
const ELEVATION_SPAN = 8000;
const CAPE_SPAN = 3000;
const CLOUD_BASE_SPAN = 5000;
const WATER_VAPOR_SPAN = 60;
const LATENT_FLUX_SPAN = 200;
const COLUMN_MASS_SPAN = 0.05;

// 風 [m/s] の東・北成分を 0.5 中心の RG に、速さを B に。
function windColor(wind: Vec2Node): Vec3Node {
  return vec3(wind.x.div(2 * WIND_SPAN).add(0.5), wind.y.div(2 * WIND_SPAN).add(0.5), length(wind).div(WIND_SPAN));
}

export const CLOUD_LAB_VIEWS: readonly CloudLabView[] = [
  { id: 'elevation', label: '標高', reads: 'climate',
    color: (d, climate) => vec3(climate.elevation(d).div(ELEVATION_SPAN)) },
  { id: 'landFraction', label: '陸らしさ', reads: 'climate',
    color: (d, climate) => vec3(climate.landFraction(d)) },
  { id: 'meanCloudiness', label: '平年の雲量', reads: 'climate',
    color: (d, climate) => vec3(climate.meanCloudiness(d)) },
  { id: 'meanWind', label: '平均風', reads: 'wind',
    color: (d, wind) => windColor(wind.sampleNode(latitudeOf(d), SURFACE_HEIGHT)) },
  { id: 'pressure', label: '気圧の偏差', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.pressureHpa.sub(PRESSURE_MIN).div(PRESSURE_SPAN)) },
  { id: 'surfaceWind', label: '地表の風', reads: 'diagnostic',
    color: (_d, diag) => windColor(vec2(diag.surfaceWindEastMps, diag.surfaceWindNorthMps)) },
  { id: 'front', label: '前線の圧縮', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.compression.sub(1).div(FRONT_SPAN)) },
  { id: 'band', label: '雲の帯', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.bandStrength) },
  { id: 'airMass', label: '気団', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.warmthRad.div(2 * WARMTH_SPAN).add(0.5)) },
  { id: 'lift', label: '上昇流', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.liftMps.div(2 * LIFT_SPAN).add(0.5)) },
  { id: 'anvil', label: '金床', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.anvil) },
  { id: 'cape', label: 'CAPE', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.capeJPerKg.div(CAPE_SPAN)) },
  { id: 'cloudBase', label: '雲底高度', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.cloudBaseM.div(CLOUD_BASE_SPAN)) },
  { id: 'upperMoisture', label: '上層の湿り', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.upperMoisture) },
  { id: 'waterVapor', label: '可降水量', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.waterVaporKgM2.div(WATER_VAPOR_SPAN)) },
  { id: 'latentFlux', label: '潜熱フラックス', reads: 'diagnostic',
    color: (_d, diag) => vec3(diag.latentFluxWPerM2.div(LATENT_FLUX_SPAN)) },
  { id: 'liquidMass', label: '液水の列質量', reads: 'mass',
    color: (_d, mass) => vec3(mass.liquidKgM2.div(COLUMN_MASS_SPAN)) },
  { id: 'iceMass', label: '氷の列質量', reads: 'mass',
    color: (_d, mass) => vec3(mass.iceKgM2.div(COLUMN_MASS_SPAN)) },
  { id: 'coverage', label: '被覆率', reads: 'cloud',
    color: (d, cloudAt) => vec3(cloudAt(d).coverage) },
  { id: 'cloudTop', label: '雲頂高度', reads: 'cloud',
    color: (d, cloudAt) => vec3(cloudAt(d).cloudTop.div(CLOUD_TOP_SPAN)) },
  { id: 'translucent', label: '薄い雲', reads: 'cloud',
    color: (d, cloudAt) => vec3(cloudAt(d).translucent.div(TRANSLUCENT_SPAN)) },
  // 被覆率と薄い雲を 1 枚に重ねた見え。晴れた空が透ける割合 (1 − 被覆率)·e^(−τ) の補で、
  // 加算と違って飽和しない。実写と見比べるための面で、描画側の合成の仕様ではない。
  { id: 'composite', label: '合成', reads: 'cloud',
    color: (d, cloudAt) => {
      const cover = cloudAt(d);
      return vec3(float(1).sub(float(1).sub(cover.coverage).mul(exp(cover.translucent.negate()))));
    } },
  { id: 'photo', label: '実写', reads: 'photo',
    color: (d, photo) => texture(photo, equirectUvFromDirection(d)).rgb },
];

// 起動時に出す量。並びが上流から下流なので、既定は先頭ではなく最終出力。
export const DEFAULT_CLOUD_LAB_VIEW: CloudLabView = CLOUD_LAB_VIEWS.find((view) => view.id === 'coverage')!;
