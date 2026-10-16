// 変化量の要素ごとの指標と合成を、様子を値で組んで検査する(静止で 0、小さな変化について 1 次、∞ の扱い)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Q_IDENTITY, qFromAxisAngle } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import {
  sceneChangeOf, sceneChangeTermsOf, type SceneChangeSample, type SceneChangeWeights,
} from '../../src/render/pipeline/scene-change';

const perspective = { kind: 'perspective', verticalFovRad: Math.PI / 3, aspect: 16 / 9 } as const;
const weights: SceneChangeWeights = { lightDirection: 10, sunlit: 1, cameraSlide: 4 };

function sample(overrides: Partial<SceneChangeSample> = {}): SceneChangeSample {
  return {
    cameraKey: 'camera',
    reference: { position: v3(), orientation: Q_IDENTITY },
    camera: { position: v3(0, 0, 10), orientation: Q_IDENTITY },
    projection: perspective,
    lights: [{ key: 'sun', direction: v3(0, 0, 1), irradiance: 1 }],
    sunlit: 1,
    ...overrides,
  };
}

export function register(): void {
  test('scene-change: 同一の様子はすべて厳密に 0', () => {
    const terms = sceneChangeTermsOf(sample(), sample());
    assert.equal(terms.lightDirection, 0);
    assert.equal(terms.sunlit, 0);
    assert.equal(terms.cameraSlide, 0);
    assert.equal(sceneChangeOf(terms, weights), 0);
  });

  test('scene-change: 基準の回転は光源方向の一次の角度になり、並進では遠方光源の方向をほぼ変えない', () => {
    const angle = 0.01;
    const rotated = sample({ reference: { position: v3(), orientation: qFromAxisAngle(v3(0, 1, 0), angle) } });
    const term = sceneChangeTermsOf(sample(), rotated).lightDirection;
    assert.ok(Math.abs(term - angle) / angle < 1e-6, `${term} != ${angle}`);
    const twice = sceneChangeTermsOf(sample(), sample({
      reference: { position: v3(), orientation: qFromAxisAngle(v3(0, 1, 0), angle * 2) },
    })).lightDirection;
    assert.ok(Math.abs(twice / term - 2) < 1e-6);
    const distant = sample({ lights: [{ key: 'sun', direction: v3(1, 0, 0), irradiance: 1 }] });
    const translated = sample({
      reference: { position: v3(1e3, 0, 0), orientation: Q_IDENTITY },
      lights: [{ key: 'sun', direction: v3(1, 0, 0), irradiance: 1 }],
    });
    assert.ok(sceneChangeTermsOf(distant, translated).lightDirection < 1e-6);
  });

  test('scene-change: 光源を鍵で対にし、照度で角度を均す', () => {
    const before = sample({ lights: [
      { key: 'a', direction: v3(1, 0, 0), irradiance: 3 },
      { key: 'b', direction: v3(1, 0, 0), irradiance: 1 },
    ] });
    const quarter = Math.PI / 4;
    const after = sample({ lights: [
      { key: 'b', direction: v3(1, 0, 0), irradiance: 1 },
      { key: 'a', direction: v3(Math.cos(quarter), Math.sin(quarter), 0), irradiance: 3 },
    ] });
    assert.ok(Math.abs(sceneChangeTermsOf(before, after).lightDirection - quarter * 3 / 4) < 1e-12);
    const added = sample({ lights: [
      { key: 'a', direction: v3(1, 0, 0), irradiance: 3 },
      { key: 'b', direction: v3(1, 0, 0), irradiance: 1 },
      { key: 'new', direction: v3(0, 0, 1), irradiance: 1 },
    ] });
    assert.ok(Math.abs(sceneChangeTermsOf(before, added).lightDirection - Math.PI / 9) < 1e-12);
  });

  test('scene-change: カメラ移動だけが滑り量を作り、基準と一緒に動くとゼロ', () => {
    const before = sample({ projection: { kind: 'orthographic', halfHeight: 100, aspect: 2 } });
    const shifted = sample({
      projection: before.projection,
      camera: { position: v3(2, 0, 10), orientation: Q_IDENTITY },
    });
    const slide = sceneChangeTermsOf(before, shifted);
    assert.equal(slide.lightDirection, 0);
    assert.equal(slide.sunlit, 0);
    assert.ok(Math.abs(slide.cameraSlide - 0.01) < 1e-12);
    const twice = sample({
      projection: before.projection,
      camera: { position: v3(4, 0, 10), orientation: Q_IDENTITY },
    });
    assert.ok(Math.abs(sceneChangeTermsOf(before, twice).cameraSlide / slide.cameraSlide - 2) < 1e-12);
    const together = sample({
      projection: before.projection,
      reference: { position: v3(1, 0, 0), orientation: Q_IDENTITY },
      camera: { position: v3(1, 0, 10), orientation: Q_IDENTITY },
    });
    assert.equal(sceneChangeTermsOf(before, together).cameraSlide, 0);
    const sharedRotation = { x: 0, y: 1, z: 0, w: 0 };
    const sharedOrigin = sample({ projection: before.projection, lights: [] });
    const sharedFrame = sample({
      projection: before.projection,
      reference: { position: v3(3, 4, 5), orientation: sharedRotation },
      camera: { position: v3(3, 4, -5), orientation: sharedRotation },
      lights: [],
    });
    assert.deepEqual(sceneChangeTermsOf(sharedOrigin, sharedFrame), {
      lightDirection: 0, sunlit: 0, cameraSlide: 0,
    });
    const orbitAngle = 0.01;
    const orbit = sample({
      projection: before.projection,
      camera: {
        position: v3(10 * Math.sin(orbitAngle), 0, 10 * Math.cos(orbitAngle)),
        orientation: qFromAxisAngle(v3(0, 1, 0), orbitAngle),
      },
    });
    assert.ok(sceneChangeTermsOf(before, orbit).cameraSlide > 0);
    assert.equal(sceneChangeTermsOf(sample(), sample({
      projection: { kind: 'orthographic', halfHeight: 10, aspect: 16 / 9 },
    })).cameraSlide, Infinity);
  });

  test('scene-change: 日照率の比を対数で測り、ゼロは明示的に扱う', () => {
    assert.equal(sceneChangeTermsOf(sample(), sample({ sunlit: 0 })).sunlit, Infinity);
    assert.equal(sceneChangeTermsOf(sample({ sunlit: 0 }), sample({ sunlit: 0 })).sunlit, 0);
    assert.equal(sceneChangeTermsOf(sample({ sunlit: 0.5 }), sample({ sunlit: 0.25 })).sunlit, Math.log(2));
    assert.equal(sceneChangeOf({ lightDirection: 0, sunlit: Infinity, cameraSlide: 0 }, {
      lightDirection: 1, sunlit: 0, cameraSlide: 1,
    }), 0);
    assert.equal(sceneChangeOf({ lightDirection: 0, sunlit: Infinity, cameraSlide: 0 }, {
      lightDirection: 0, sunlit: 1, cameraSlide: 0,
    }), Infinity);
    assert.throws(() => sceneChangeOf({ lightDirection: 0, sunlit: 0, cameraSlide: 0 }, {
      lightDirection: NaN, sunlit: 1, cameraSlide: 1,
    }), RangeError);
    assert.throws(() => sceneChangeOf({ lightDirection: 0, sunlit: 0, cameraSlide: 0 }, {
      lightDirection: 1, sunlit: 1, cameraSlide: -1,
    }), RangeError);
  });
}
