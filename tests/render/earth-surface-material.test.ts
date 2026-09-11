// 地表material契約の座標、色空間、親子遷移、法線選択を解析的に検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import * as THREE from 'three/webgpu';
import {
  EARTH_ICE_ROUGHNESS, EARTH_LAND_ROUGHNESS, EARTH_WATER_ROUGHNESS,
  earthSurfaceBodyNormalToView, earthSurfaceEllipsoidUv, earthSurfaceNormalForView,
  earthSurfacePageCell, earthSurfaceTileLocalUv, mixEarthSurfaceMaterial, roughnessFromGshhgCoverage,
  sampleEarthSurfacePage, srgbChannelToLinear,
} from '../../src/render/earth-surface-material';
import type {
  EarthSurfaceLayerSample, EarthSurfaceMaterialLayerReader,
} from '../../src/render/earth-surface-material';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from '../../src/render/earth-surface-page-table';
import { earthTileKey } from '../../src/render/earth-surface-tile-key';

function layer(colorSrgb: { readonly r: number; readonly g: number; readonly b: number }, roughness: number,
  bodyNormal = new THREE.Vector3(0, 1, 0)): EarthSurfaceLayerSample {
  return { colorSrgb, terrain: { bodyNormal, roughness } };
}

class MaterialReader implements EarthSurfaceMaterialLayerReader {
  public readonly detailUvs: Array<{ readonly layer: number; readonly uv: THREE.Vector2 }> = [];

  public constructor(private readonly base: EarthSurfaceLayerSample, private readonly details: ReadonlyMap<number, EarthSurfaceLayerSample>) {}

  public sampleDetail(layerNumber: number, uv: THREE.Vector2): EarthSurfaceLayerSample {
    this.detailUvs.push({ layer: layerNumber, uv: uv.clone() });
    const sample = this.details.get(layerNumber);
    if (sample === undefined) throw new Error(`missing material layer ${layerNumber}`);
    return sample;
  }

  public sampleBase(_uv: THREE.Vector2): EarthSurfaceLayerSample { return this.base; }
}

export function register(): void {
  test('earth material: 非一様半軸から楕円体法線と地理UVを解析的に求める', () => {
    const axes = new THREE.Vector3(2, 3, 4);
    const result = earthSurfaceEllipsoidUv(new THREE.Vector3(1, 0, 1), axes);
    const expected = new THREE.Vector3(1 / 4, 0, 1 / 16).normalize();
    assert.ok(result.normal.distanceTo(expected) < 1e-12);
    assert.ok(result.uv.x >= 0 && result.uv.x <= 1);
    assert.ok(result.uv.y >= 0 && result.uv.y <= 1);
    assert.equal(earthSurfaceEllipsoidUv(new THREE.Vector3(0, 1, 0), axes).uv.y, 0);
    assert.equal(earthSurfaceEllipsoidUv(new THREE.Vector3(0, -1, 0), axes).uv.y, 1);
    const west = earthSurfaceEllipsoidUv(new THREE.Vector3(-1e-12, 0, -1), axes).uv.x;
    const east = earthSurfaceEllipsoidUv(new THREE.Vector3(1e-12, 0, -1), axes).uv.x;
    assert.ok(west < 1e-10);
    assert.ok(east > 1 - 1e-10);
  });

  test('earth material: ページ表は最近傍、経度は周期、極は最終セルへクランプする', () => {
    const table = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(255);
    const set = (x: number, y: number, value: readonly [number, number, number, number]): void => {
      table.set(value, (y * EARTH_PAGE_WIDTH + x) * 4);
    };
    set(0, 0, [3, 2, 4, 128]);
    set(0, EARTH_PAGE_HEIGHT - 1, [4, 1, 5, 255]);
    set(EARTH_PAGE_WIDTH - 1, EARTH_PAGE_HEIGHT - 1, [4, 1, 5, 255]);
    assert.deepEqual(earthSurfacePageCell(table, 0, 0), { layer: 3, parentLayer: 2, z: 4, fade: 128 / 255 });
    assert.deepEqual(earthSurfacePageCell(table, -1 / EARTH_PAGE_WIDTH / 2, 1), { layer: 4, parentLayer: 1, z: 5, fade: 1 });
    assert.deepEqual(earthSurfacePageCell(table, 0, 1), { layer: 4, parentLayer: 1, z: 5, fade: 1 });
    const invalid = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(255);
    invalid.set([3, 2, 3, 255]);
    assert.throws(() => earthSurfacePageCell(invalid, 0, 0), /Invalid Earth page level/);
  });

  test('earth material: タイルUVは経度wrap、極clamp、2texel gutterを共有する', () => {
    const key = earthTileKey(4, 0, 0);
    const wrapped = earthSurfaceTileLocalUv(-0.001, 0, key).uv;
    const north = earthSurfaceTileLocalUv(0.01, -10, key).uv;
    const south = earthSurfaceTileLocalUv(0.01, 10, earthTileKey(4, 0, 15)).uv;
    assert.ok(wrapped.x > 0 && wrapped.x < 1);
    assert.equal(north.y, (2 + 0.5) / 260);
    assert.equal(south.y, (2 + 0.5 + 256) / 260);
    assert.ok(earthSurfaceTileLocalUv(1.001, 0.5, key).uv.x > 0);
  });

  test('earth material: 色はsRGBを線形化してから親子混合し、roughnessは色の青さを見ない', () => {
    assert.equal(srgbChannelToLinear(0), 0);
    assert.equal(srgbChannelToLinear(1), 1);
    const parent = layer({ r: 0, g: 0, b: 0 }, EARTH_WATER_ROUGHNESS);
    const child = layer({ r: 1, g: 1, b: 1 }, EARTH_LAND_ROUGHNESS);
    const mixed = mixEarthSurfaceMaterial(parent, child, 0.5);
    assert.deepEqual(mixed.colorLinear, { r: 0.5, g: 0.5, b: 0.5 });
    assert.ok(Math.abs(mixed.roughness - (EARTH_WATER_ROUGHNESS + EARTH_LAND_ROUGHNESS) / 2) < 1e-12);
    assert.equal(roughnessFromGshhgCoverage({ landFraction: 1, iceFraction: 0 }), EARTH_LAND_ROUGHNESS);
    assert.equal(roughnessFromGshhgCoverage({ landFraction: 1, iceFraction: 1 }), EARTH_ICE_ROUGHNESS);
    assert.equal(roughnessFromGshhgCoverage({ landFraction: 0, iceFraction: 0 }), EARTH_WATER_ROUGHNESS);
    // 青い陸地もGSHHG被覆率が陸なら陸の固定roughnessを使う。
    assert.equal(roughnessFromGshhgCoverage({ landFraction: 1, iceFraction: 0 }), 0.8);
  });

  test('earth material: 親子fadeは同じ地理UVから現在層と親層を読み、R=255はbaseへ戻る', () => {
    const reader = new MaterialReader(
      layer({ r: 0.25, g: 0.25, b: 0.25 }, EARTH_WATER_ROUGHNESS),
      new Map([
        [1, layer({ r: 0, g: 0, b: 0 }, EARTH_WATER_ROUGHNESS)],
        [2, layer({ r: 1, g: 1, b: 1 }, EARTH_LAND_ROUGHNESS)],
      ]),
    );
    const faded = sampleEarthSurfacePage(reader, { layer: 2, parentLayer: 1, z: 5, fade: 0.5 }, 1.2, -0.1);
    assert.deepEqual(faded.colorLinear, { r: 0.5, g: 0.5, b: 0.5 });
    assert.ok(Math.abs(faded.roughness - (EARTH_WATER_ROUGHNESS + EARTH_LAND_ROUGHNESS) / 2) < 1e-12);
    assert.equal(reader.detailUvs.length, 2);
    const base = sampleEarthSurfacePage(reader, { layer: 255, parentLayer: 255, z: 255, fade: 1 }, 1.2, -0.1);
    assert.equal(base.colorLinear.r, srgbChannelToLinear(0.25));
  });

  test('earth material: body法線はviewへ一度だけ変換し、模式図は幾何楕円体法線を選ぶ', () => {
    const body = new THREE.Vector3(1, 0, 0);
    const geometric = new THREE.Vector3(0, 1, 0);
    const rotate = new THREE.Matrix3().set(0, -1, 0, 1, 0, 0, 0, 0, 1);
    assert.ok(earthSurfaceBodyNormalToView(body, rotate).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-12);
    assert.deepEqual(body.toArray(), [1, 0, 0]);
    assert.ok(earthSurfaceNormalForView('schematic', body, geometric, rotate).distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-12);
    assert.ok(earthSurfaceNormalForView('realistic', body, geometric, rotate).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-12);
  });

}
