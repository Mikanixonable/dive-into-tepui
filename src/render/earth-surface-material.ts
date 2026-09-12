// 地球表面のページ表・タイル・材質を同じ地理UVから読む解析契約。
//
// このモジュールはThree.jsのテクスチャやTSLノードを生成しない。GPU側の配列層を
// 置き換えられるよう、ページ表の最近傍読取り、タイル内UV、親子遷移、色空間、法線の
// 座標系を値と純粋関数で固定する。
import * as THREE from 'three/webgpu';
import {
  EARTH_BASE_LAYER, EARTH_TILE_EXTENT, EARTH_TILE_GUTTER, EARTH_TILE_MAX_Z, EARTH_TILE_TEXELS, EARTH_TILE_MIN_Z,
  earthTileKey,
} from './earth-surface-tile-key';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH, earthPageAt } from './earth-surface-page-table';
import type { EarthTileKey } from './earth-surface-tile-key';
import { earthSurfaceNormal, earthSurfaceUv, validateEarthAxes } from './earth-surface-coordinate';

export type EarthSurfaceColorSpace = 'srgb';
export type EarthSurfaceTerrainColorSpace = 'none';
export type EarthSurfaceColorFilter = 'linear';
export type EarthSurfacePageFilter = 'nearest';

export interface EarthSurfaceEllipsoidUv {
  readonly normal: THREE.Vector3;
  readonly uv: THREE.Vector2;
}

// 楕円体上の放射方向から外向き楕円体法線と地理UVを一度に求める。
// 放射方向の長さには依存しないが、ゼロ方向は受け付けない。
export function earthSurfaceEllipsoidUv(direction: THREE.Vector3, axes: THREE.Vector3): EarthSurfaceEllipsoidUv {
  validateEarthAxes(axes);
  if (direction.lengthSq() === 0 || !Number.isFinite(direction.lengthSq())) {
    throw new RangeError('Earth surface direction must be finite and nonzero');
  }
  const normal = earthSurfaceNormal(direction, axes);
  return { normal, uv: earthSurfaceUv(direction, axes) };
}

export interface EarthSurfacePageCell {
  readonly layer: number;
  readonly parentLayer: number;
  readonly z: number;
  // 0は親、1は現在層。ページ表alphaの8bit値を正規化したもの。
  readonly fade: number;
}

// ページ表はテクスチャ補間を使わず、地理UVが属するz=7セルをfloorで最近傍読取りする。
// uは周期、vは極でクランプし、v=1だけは最終行へ置く。
export function earthSurfacePageCell(table: Uint8Array, u: number, v: number): EarthSurfacePageCell {
  if (table.length !== EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4) throw new RangeError('Invalid Earth page table');
  finiteUnit(u, 'Earth page longitude UV');
  finiteUnit(v, 'Earth page latitude UV');
  const raw = earthPageAt(table, u, v);
  const layer = raw[0]!;
  const parentLayer = raw[1]!;
  const z = raw[2]!;
  const fadeByte = raw[3]!;
  if (layer === EARTH_BASE_LAYER && (parentLayer !== EARTH_BASE_LAYER || z !== EARTH_BASE_LAYER)) {
    throw new Error('Invalid Earth base page cell');
  }
  if (layer !== EARTH_BASE_LAYER && (z < EARTH_TILE_MIN_Z || z > EARTH_TILE_MAX_Z)) throw new Error('Invalid Earth page level');
  return { layer, parentLayer, z, fade: fadeByte / 255 };
}

export interface EarthSurfaceTileLocalUv {
  readonly key: EarthTileKey;
  readonly uv: THREE.Vector2;
}

function finiteUnit(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

// 全球UVを指定タイルの260x260画像へ写す。色・地形とも同じ座標を使う。
// 経度は周期、緯度は極でクランプし、内側256画素の外側へ2画素のgutterを確保する。
export function earthSurfaceTileLocalUv(u: number, v: number, key: EarthTileKey): EarthSurfaceTileLocalUv {
  finiteUnit(u, 'Earth longitude UV');
  finiteUnit(v, 'Earth latitude UV');
  const columns = 2 ** (key.z + 1);
  const rows = 2 ** key.z;
  const globalX = THREE.MathUtils.euclideanModulo(u, 1) * columns;
  const globalY = THREE.MathUtils.clamp(v, 0, 1) * rows;
  const localU = THREE.MathUtils.euclideanModulo(globalX - key.x, 1);
  const localV = THREE.MathUtils.clamp(globalY - key.y, 0, 1);
  const tileU = (EARTH_TILE_GUTTER + 0.5 + EARTH_TILE_TEXELS * localU) / EARTH_TILE_EXTENT;
  const tileV = (EARTH_TILE_GUTTER + 0.5 + EARTH_TILE_TEXELS * localV) / EARTH_TILE_EXTENT;
  return { key, uv: new THREE.Vector2(tileU, tileV) };
}

export interface EarthSurfaceColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface EarthSurfaceTerrainSample {
  // ESTN RGBのbody-fixed外向き単位法線。半軸の逆転置をここで再適用しない。
  readonly bodyNormal: THREE.Vector3;
  // ESTN alpha。NoColorSpaceの線形値で地表分類から導いた値を表す。
  readonly roughness: number;
}

export interface EarthSurfaceLayerSample {
  readonly colorSrgb: EarthSurfaceColor;
  readonly terrain: EarthSurfaceTerrainSample;
}

export interface EarthSurfaceLinearColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface EarthSurfaceMaterialSample {
  readonly colorLinear: EarthSurfaceLinearColor;
  readonly normalBody: THREE.Vector3;
  readonly roughness: number;
}

function checkUnitChannel(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be in [0, 1]`);
  return value;
}

// sRGBの1チャンネルを線形値へ変換する。色の補間前に必ず呼び出す。
export function srgbChannelToLinear(value: number): number {
  checkUnitChannel(value, 'sRGB channel');
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function srgbColorToLinear(color: EarthSurfaceColor): EarthSurfaceLinearColor {
  return { r: srgbChannelToLinear(color.r), g: srgbChannelToLinear(color.g), b: srgbChannelToLinear(color.b) };
}

function checkedRoughness(value: number): number {
  return checkUnitChannel(value, 'Earth roughness');
}

function checkedNormal(normal: THREE.Vector3): THREE.Vector3 {
  if (![normal.x, normal.y, normal.z].every(Number.isFinite) || normal.lengthSq() === 0) {
    throw new RangeError('Earth material normal must be finite and nonzero');
  }
  return normal.clone().normalize();
}

function mixNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function mixColor(from: EarthSurfaceLinearColor, to: EarthSurfaceLinearColor, amount: number): EarthSurfaceLinearColor {
  return {
    r: mixNumber(from.r, to.r, amount), g: mixNumber(from.g, to.g, amount), b: mixNumber(from.b, to.b, amount),
  };
}

function materialSample(sample: EarthSurfaceLayerSample): EarthSurfaceMaterialSample {
  const colorLinear = srgbColorToLinear(sample.colorSrgb);
  return {
    colorLinear,
    normalBody: checkedNormal(sample.terrain.bodyNormal),
    roughness: checkedRoughness(sample.terrain.roughness),
  };
}

// 親子の材質を、色は線形RGB、法線はベクトル、roughnessは線形値として混ぜる。
export function mixEarthSurfaceMaterial(
  parent: EarthSurfaceLayerSample, child: EarthSurfaceLayerSample, fade: number,
): EarthSurfaceMaterialSample {
  const amount = checkUnitChannel(fade, 'Earth material fade');
  const from = materialSample(parent);
  const to = materialSample(child);
  return {
    colorLinear: mixColor(from.colorLinear, to.colorLinear, amount),
    normalBody: from.normalBody.clone().lerp(to.normalBody, amount).normalize(),
    roughness: mixNumber(from.roughness, to.roughness, amount),
  };
}

export interface EarthSurfaceGshhgCoverage {
  readonly landFraction: number;
  readonly iceFraction: number;
}

export const EARTH_WATER_ROUGHNESS = 0.05;
export const EARTH_LAND_ROUGHNESS = 0.80;
export const EARTH_ICE_ROUGHNESS = 0.35;

// GSHHGの面積被覆率から固定クラス値を求める。BMNGの青さ・明るさは参照しない。
export function roughnessFromGshhgCoverage(coverage: EarthSurfaceGshhgCoverage): number {
  const land = checkUnitChannel(coverage.landFraction, 'GSHHG land coverage');
  const ice = checkUnitChannel(coverage.iceFraction, 'GSHHG ice coverage');
  if (ice > land) throw new RangeError('GSHHG ice coverage cannot exceed land coverage');
  const water = 1 - land;
  const nonIceLand = land - ice;
  return water * EARTH_WATER_ROUGHNESS + nonIceLand * EARTH_LAND_ROUGHNESS + ice * EARTH_ICE_ROUGHNESS;
}

export type EarthSurfaceNormalMode = 'realistic' | 'schematic';

// body固定法線をviewへ一度だけ回す。半軸やモデル行列の逆転置を追加で適用しない。
export function earthSurfaceBodyNormalToView(bodyNormal: THREE.Vector3, bodyToView: THREE.Matrix3): THREE.Vector3 {
  return checkedNormal(bodyNormal).applyMatrix3(bodyToView).normalize();
}

// 模式図では地形法線を使わず、同じ楕円体の幾何法線を選ぶ。
export function earthSurfaceNormalForView(
  mode: EarthSurfaceNormalMode, bodyNormal: THREE.Vector3, geometricNormal: THREE.Vector3, bodyToView: THREE.Matrix3,
): THREE.Vector3 {
  return earthSurfaceBodyNormalToView(mode === 'schematic' ? geometricNormal : bodyNormal, bodyToView);
}

export interface EarthSurfaceMaterialLayerReader {
  sampleDetail(layer: number, uv: THREE.Vector2): EarthSurfaceLayerSample;
  sampleBase(uv: THREE.Vector2): EarthSurfaceLayerSample;
}

function samplePageLayer(
  reader: EarthSurfaceMaterialLayerReader, layer: number, z: number, u: number, v: number,
): EarthSurfaceLayerSample {
  finiteUnit(u, 'Earth material longitude UV');
  finiteUnit(v, 'Earth material latitude UV');
  if (layer === EARTH_BASE_LAYER) return reader.sampleBase(new THREE.Vector2(THREE.MathUtils.euclideanModulo(u, 1), THREE.MathUtils.clamp(v, 0, 1)));
  if (!Number.isInteger(z) || z < EARTH_TILE_MIN_Z || z > EARTH_TILE_MAX_Z) throw new RangeError('Invalid Earth material page level');
  const rows = 2 ** z;
  const columns = 2 * rows;
  const key = earthTileKey(z, Math.floor(THREE.MathUtils.euclideanModulo(u, 1) * columns), Math.min(rows - 1, Math.floor(THREE.MathUtils.clamp(v, 0, 1) * rows)));
  return reader.sampleDetail(layer, earthSurfaceTileLocalUv(u, v, key).uv);
}

// ページ表セルに従い、現在層と親層を同じ地理UVで読む。R=255は常に全球baseへ戻る。
export function sampleEarthSurfacePage(
  reader: EarthSurfaceMaterialLayerReader, cell: EarthSurfacePageCell, u: number, v: number,
): EarthSurfaceMaterialSample {
  checkUnitChannel(cell.fade, 'Earth material fade');
  const current = samplePageLayer(reader, cell.layer, cell.z, u, v);
  if (cell.layer === EARTH_BASE_LAYER || cell.parentLayer === EARTH_BASE_LAYER || cell.fade >= 1) {
    return materialSample(current);
  }
  const parent = samplePageLayer(reader, cell.parentLayer, cell.z - 1, u, v);
  return mixEarthSurfaceMaterial(parent, current, cell.fade);
}
