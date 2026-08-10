import * as assert from 'node:assert/strict';
import {
  blendTerrainNormals,
  deterministicDetailNormal,
  EARTH_OBLIQUITY,
  ICE_AGE_EARTH,
  seasonalLongitudeAt,
  seasonalSurfaceFactors,
  solarDeclination,
  surfaceMaterialMasks,
  terrainNormalFromEquirectangular,
  TROPICAL_YEAR_SECONDS,
} from '../../src/physics/surface-material';
import { test } from './harness';

function length(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function register(): void {
  test('季節位相は一年で周期的に戻る', () => {
    assert.ok(Math.abs(seasonalLongitudeAt(0) - seasonalLongitudeAt(TROPICAL_YEAR_SECONDS)) < 1e-12);
    assert.ok(Math.abs(solarDeclination(Math.PI / 2) - EARTH_OBLIQUITY) < 1e-12);
  });

  test('氷河期の極域は低緯度より雪氷が多く、夏季は植生活動を増やす', () => {
    const northWinter = seasonalSurfaceFactors(70 * Math.PI / 180, Math.PI * 1.5);
    const northSummer = seasonalSurfaceFactors(70 * Math.PI / 180, Math.PI * 0.5);
    assert.ok(northWinter.snowPersistence > northSummer.snowPersistence);
    assert.ok(northSummer.vegetationActivity > northWinter.vegetationActivity);
    assert.ok(northWinter.snowPersistence > seasonalSurfaceFactors(20 * Math.PI / 180, Math.PI * 1.5).snowPersistence);
  });

  test('地表マスクは範囲内で海・陸・氷雪・植生を分離する', () => {
    const factors = seasonalSurfaceFactors(45 * Math.PI / 180, Math.PI * 0.5);
    const masks = surfaceMaterialMasks({ landness: 0.9, terrainHeight: 0.75, latitude: 45 * Math.PI / 180, localVariation: 0.7 }, factors);
    assert.ok(masks.land > masks.ocean);
    assert.ok(masks.iceSnow > 0);
    assert.ok(masks.vegetation >= 0 && masks.vegetation <= 1);
    assert.ok(masks.rock >= 0 && masks.rock <= 1);
  });

  test('equirectangular地形勾配と月面detail法線は正規化される', () => {
    const normal = terrainNormalFromEquirectangular(0.25, 0.4, 0.1, 0.9, 0.2, 0.4);
    const detail = deterministicDetailNormal(0.3, 0.8, -0.2, 3);
    const blended = blendTerrainNormals(normal, detail, 0.45);
    assert.ok(Math.abs(length(normal) - 1) < 1e-12);
    assert.ok(Math.abs(length(detail) - 1) < 1e-12);
    assert.ok(Math.abs(length(blended) - 1) < 1e-12);
    assert.notDeepEqual(normal, terrainNormalFromEquirectangular(0.25, 0.4, 0.1, 0.1, 0.2, 0.2));
  });

  test('不正な時刻でも季節係数は決定論的な有限値を返す', () => {
    const factors = seasonalSurfaceFactors(0, seasonalLongitudeAt(Number.NaN), ICE_AGE_EARTH);
    assert.ok(Number.isFinite(factors.snowPersistence));
    assert.ok(Number.isFinite(factors.vegetationActivity));
  });
}
