import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  decodeMonthlyClimateRgba,
  mixMonthlyClimateRgba,
  MonthlyClimateMap,
  normalizeClimateMonth,
} from '../../src/render/cloud/monthly-climate-map';
import type { MonthlyClimateTexture } from '../../src/render/cloud/monthly-climate-map';
import {
  createDevelopmentClimateMap,
  developmentClimateRgba,
} from '../../src/render/cloud/monthly-climate-fixture';

class TextureSpy implements MonthlyClimateTexture {
  public readonly texture = new THREE.Texture();
  public requestCount = 0;
  public disposeCount = 0;
  public generation = 0;

  public request(): void { this.requestCount += 1; }
  public dispose(): void { this.disposeCount += 1; }
}

function maps(): TextureSpy[] {
  return Array.from({ length: 12 }, () => new TextureSpy());
}

export function register(): void {
  test('monthly climate: 月の負値・12月を年周回として正規化する', () => {
    assert.equal(normalizeClimateMonth(12), 0);
    assert.equal(normalizeClimateMonth(-1), 11);
    assert.equal(normalizeClimateMonth(2.9), 2);
  });

  test('monthly climate: current/nextの2枚だけを要求する', () => {
    const textures = maps();
    const climate = new MonthlyClimateMap(textures);
    for (const value of textures) {
      assert.equal(value.texture.colorSpace, THREE.NoColorSpace);
      assert.equal(value.texture.wrapS, THREE.RepeatWrapping);
      assert.equal(value.texture.wrapT, THREE.ClampToEdgeWrapping);
      assert.equal(value.texture.minFilter, THREE.LinearFilter);
      assert.equal(value.texture.magFilter, THREE.LinearFilter);
      assert.equal(value.texture.generateMipmaps, false);
    }

    climate.setMonth(11, 0.25);
    assert.deepEqual(textures.map((value) => value.requestCount),
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

    textures.forEach((value) => { value.requestCount = 0; });
    climate.setMonth(-1, 0.5);
    assert.deepEqual(textures.map((value) => value.requestCount),
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    climate.dispose();
    assert.ok(textures.every((value) => value.disposeCount === 1));
  });

  test('monthly climate: RGBAを同一UVの線形補間として契約範囲へ復号する', () => {
    const current = decodeMonthlyClimateRgba([0, 0, 0, 0]);
    const next = decodeMonthlyClimateRgba([1, 1, 1, 1]);
    const middle = mixMonthlyClimateRgba([0, 0, 0, 0], [1, 1, 1, 1], 0.5);

    assert.deepEqual(current, {
      temperatureK: 180, cloudiness: 0, elevationM: -1000, landFraction: 0,
    });
    assert.deepEqual(next, {
      temperatureK: 330, cloudiness: 1, elevationM: 9000, landFraction: 1,
    });
    assert.deepEqual(middle, {
      temperatureK: 255, cloudiness: 0.5, elevationM: 4000, landFraction: 0.5,
    });
  });

  test('monthly climate: current/nextの世代変化を単調なgenerationへ伝播する', () => {
    const textures = maps();
    const climate = new MonthlyClimateMap(textures);
    const first = climate.generation;
    textures[0]!.generation = 1;
    const second = climate.generation;
    climate.setMonth(4, 0);
    const third = climate.generation;
    assert.ok(second > first);
    assert.ok(third > second);
    climate.dispose();
  });

  test('monthly climate: source差し替え中は現在の12枚をfallbackとして保持する', () => {
    const textures = maps();
    const climate = new MonthlyClimateMap(textures);
    climate.setMonth(11, 0.5);
    const generation = climate.generation;
    climate.replaceUrls(Array.from({ length: 12 }, (_, index) => `https://example.test/${index}.png`));
    assert.ok(climate.generation >= generation);
    assert.ok(textures.every((value) => value.disposeCount === 0));
    climate.dispose();
    assert.ok(textures.every((value) => value.disposeCount === 1));
  });

  test('monthly climate: 開発用fallbackは雲量と陸地被覆率に変化を持つ', () => {
    const pixels = developmentClimateRgba(0);
    let cloudMin = 255;
    let cloudMax = 0;
    let landMin = 255;
    let landMax = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      cloudMin = Math.min(cloudMin, pixels[index + 1]!);
      cloudMax = Math.max(cloudMax, pixels[index + 1]!);
      landMin = Math.min(landMin, pixels[index + 3]!);
      landMax = Math.max(landMax, pixels[index + 3]!);
    }
    assert.ok(cloudMin < cloudMax);
    assert.ok(cloudMax > 0);
    assert.ok(landMin < landMax);

    const climate = createDevelopmentClimateMap();
    assert.ok(climate.generation > 0);
    climate.dispose();
  });
}
