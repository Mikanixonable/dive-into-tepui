// 直射日光の大気減衰の回帰テスト。GPU では SunExtinction が sunPathGeometry の
// (天頂角余弦・高度) で sun-transmittance-tables.ts の焼き込んだ表を引く —
// CPU 側は同じ経路の値版(sun-path-depth.ts)と焼いた表の中身を、GPU が読むのと同じ
// 双線形補間で引いて検証する。地球の光学と大きさは src の定義から取り、値をここへ写さない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { test } from '../harness';
import { evaluateShaderNode, type ShaderValue } from './tsl-node-evaluator';
import {
  depthToSpace, depthToSpaceValue, layerDepthValue, polarStretchOf, sunPathGeometry,
  type SunPathAtmosphere,
} from '../../src/render/pipeline/sun-path-depth';
import {
  bakeSunTransmittance, sampleSunTransmittance, SunTransmittanceTables,
} from '../../src/render/pipeline/sun-transmittance-tables';
import { EARTH, EARTH_ATMOSPHERE_OPTICS, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import type { AtmosphereBody } from '../../src/render/atmosphere';
import type { Vec3Node } from '../../src/render/tsl-types';

const OPTICS = EARTH_ATMOSPHERE_OPTICS;
const SURFACE_RADIUS = R_EARTH_EQ;
const SUN_DISTANCE = 1.5e11;

const num = (value: ShaderValue): number => value as number;
const pointNode = (point: THREE.Vector3): Vec3Node => vec3(point.x, point.y, point.z);

// 原点中心の地球大気。雲の有無は減衰に関係しない。
function earthAtmosphere(overrides: Partial<AtmosphereBody> = {}): AtmosphereBody {
  return {
    center: new THREE.Vector3(),
    surfaceRadius: SURFACE_RADIUS,
    polarAxis: new THREE.Vector3(0, 1, 0),
    polarRatio: 1,
    optics: OPTICS,
    clouds: null,
    ...overrides,
  };
}

// 焼いた表の CPU 側の引き方。GPU と同じく、点の幾何(経路式の TSL 版を評価)から
// (天頂角余弦・高度) を取って双線形に引く。
function transmittanceAt(body: AtmosphereBody, point: THREE.Vector3, mu: number): number[] {
  const { data, altitudeMax } = bakeSunTransmittance(body.optics, body.surfaceRadius);
  const sunPos = new THREE.Vector3(Math.sqrt(1 - mu * mu), mu, 0).multiplyScalar(SUN_DISTANCE);
  const atmosphere: SunPathAtmosphere = {
    center: vec3(body.center.x, body.center.y, body.center.z),
    surfaceRadius: float(body.surfaceRadius),
    polarAxis: vec3(body.polarAxis.x, body.polarAxis.y, body.polarAxis.z),
    polarStretch: float(polarStretchOf(body.polarRatio)),
  };
  const path = sunPathGeometry(pointNode(point), vec3(sunPos.x, sunPos.y, sunPos.z), atmosphere);
  const sunMu = num(evaluateShaderNode(path.sunMu));
  const radius = num(evaluateShaderNode(path.radius));
  const surfaceRadius = num(evaluateShaderNode(atmosphere.surfaceRadius));
  return [...sampleSunTransmittance(data, altitudeMax, sunMu, Math.max(radius - surfaceRadius, 0))];
}

const surfacePoint = new THREE.Vector3(0, SURFACE_RADIUS, 0);

export function register(): void {
  test('sun-transmittance: 焼いた表の全要素が 0..1 に収まる', () => {
    const { data } = bakeSunTransmittance(OPTICS, SURFACE_RADIUS);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        assert.ok(
          data[i + c]! >= 0 && data[i + c]! <= 1,
          `要素 ${i + c} が範囲外: ${data[i + c]}`,
        );
      }
      assert.equal(data[i + 3], 1, 'アルファが 1 でない');
    }
  });

  test('sun-transmittance: 空き枠の表は全帯域で 1(素通し)', () => {
    const tables = new SunTransmittanceTables();
    const empty = tables.forEmpty();
    // 1×1 の表なので、どの uv を引いても白が返る。中身は半精度の列。
    const bits = empty.texture.image.data as Uint16Array;
    assert.deepEqual(
      [...bits.slice(0, 4)].map((v) => THREE.DataUtils.fromHalfFloat(v)),
      [1, 1, 1, 1],
    );
    tables.dispose();
  });

  test('sun-transmittance: 天頂の太陽では帯域実効の解析解へ収まる', () => {
    // 表は分光から帯域へ畳んで焼く — G 帯の実効の厚みは宣言の係数へ合わせてあるので
    // G は exp(−柱量) とほぼ一致し、R・B は帯域の中の再配分で数 % ずれる程度に収まる。
    const rgb = transmittanceAt(earthAtmosphere(), surfacePoint, 1);
    const ozoneColumn = OPTICS.ozone!.halfThickness;
    const expected = (channel: number) => Math.exp(-(
      OPTICS.rayleigh.getComponent(channel) * OPTICS.rayleighScaleHeight
      + OPTICS.mie * OPTICS.mieScaleHeight
      + OPTICS.ozone!.absorption.getComponent(channel) * ozoneColumn
    ));
    assert.ok(
      Math.abs(rgb[1]! / expected(1) - 1) < 0.05,
      `G が解析解から外れた: ${rgb[1]} vs ${expected(1)}`,
    );
    for (const channel of [0, 2]) {
      assert.ok(
        Math.abs(rgb[channel]! / expected(channel) - 1) < 0.3,
        `channel ${channel}: ${rgb[channel]} vs ${expected(channel)}`,
      );
    }
  });

  test('sun-transmittance: 太陽を沈めるほど透過率は下がる', () => {
    const mus = [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0.02, 0, -0.01, -0.02, -0.03, -0.05];
    let previous = Number.POSITIVE_INFINITY;
    for (const mu of mus) {
      const rgb = transmittanceAt(earthAtmosphere(), surfacePoint, mu);
      const current = (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
      assert.ok(
        current <= previous * (1 + 1e-9),
        `mu=${mu} で透過率が増えた: ${previous} -> ${current}`,
      );
      previous = current;
    }
    // 地平線直下まで表が届く。さらに深い沈みでは端の値へ張り付いて 0 には飛ばない。
    assert.ok(previous > 0, '深い沈みで透過率が 0 になった');
  });

  test('sun-transmittance: 地平線付近では赤のほうが透過率が大きい', () => {
    const rgb = transmittanceAt(earthAtmosphere(), surfacePoint, 0);
    assert.ok(rgb[0]! > rgb[1]! && rgb[1]! > rgb[2]!, `波長順が乱れている: ${rgb}`);
  });

  test('sun-transmittance: 同じ太陽の高さでは、高い点ほど透過率が大きい', () => {
    const surface = transmittanceAt(earthAtmosphere(), surfacePoint, 0.1);
    const high = transmittanceAt(
      earthAtmosphere(), new THREE.Vector3(0, SURFACE_RADIUS + 10e3, 0), 0.1,
    );
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        high[channel]! > surface[channel]!,
        `channel ${channel}: ${high[channel]} <= ${surface[channel]}`,
      );
    }
  });

  test('sun-transmittance: 高い点は局所の地平線の下の太陽でも透過率が 0 にならない', () => {
    const point = new THREE.Vector3(0, SURFACE_RADIUS + 2e3, 0);
    // 高度 2km では局所の地平線は真の水平から約 1.6° 下がる。1° 下の太陽はまだ見えている。
    const mu = -Math.sin(THREE.MathUtils.degToRad(1));
    const near = transmittanceAt(earthAtmosphere(), point, mu);
    const far = transmittanceAt(earthAtmosphere(), point, mu * 2);
    const nearMean = (near[0]! + near[1]! + near[2]!) / 3;
    const farMean = (far[0]! + far[1]! + far[2]!) / 3;
    assert.ok(nearMean > 0, '地平線下 1° で透過率が 0 になった');
    assert.ok(farMean < nearMean, `沈むほど下がらない: ${nearMean} -> ${farMean}`);
  });

  test('sun-transmittance: 扁平な天体でも、極の地表では真球の天頂と同じ表を引く', () => {
    const shape = EARTH.shape as { equatorRadius: number; polarRadius: number };
    const polarRatio = shape.polarRadius / shape.equatorRadius;
    const body = earthAtmosphere({ polarRatio });
    // 極の地表の点(描画座標では極半径ぶんの高さ)。真球空間では天頂と同じ形になる。
    const poleSurface = new THREE.Vector3(0, shape.polarRadius, 0);
    const oblate = transmittanceAt(body, poleSurface, 1);
    const sphere = transmittanceAt(earthAtmosphere(), surfacePoint, 1);
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        Math.abs(oblate[channel]! / sphere[channel]! - 1) < 0.05,
        `channel ${channel}: 扁平な天体で表の引き方がずれた ${oblate[channel]} vs ${sphere[channel]}`,
      );
    }
  });

  test('sun-transmittance: 表の持ち主は同じ光学で焼き直さない', () => {
    const tables = new SunTransmittanceTables();
    const body = earthAtmosphere();
    const first = tables.forBody(body);
    const second = tables.forBody(earthAtmosphere());
    assert.equal(first.texture, second.texture, '同じ光学で表が焼き直された');
    assert.ok(first.altitudeMax > 0);
    const { data, altitudeMax } = tables.sunDataFor(body);
    assert.ok(data.length > 0 && altitudeMax === first.altitudeMax);
    tables.dispose();
  });

  test('sun-path-depth: 値版と TSL 版が同じ厚みを出す(孪生の対応)', () => {
    // 焼き込み側の depthToSpaceValue と、大気積分が読む TSL の depthToSpace が
    // 同じ式でなければ、焼いた表と絵が食い違う。
    const cases: [number, number][] = [
      [SURFACE_RADIUS, 1], [SURFACE_RADIUS, 0.5], [SURFACE_RADIUS, 0.1],
      [SURFACE_RADIUS, 0], [SURFACE_RADIUS, -0.02], [SURFACE_RADIUS + 10e3, 0.2],
      [SURFACE_RADIUS + 10e3, -0.05], [SURFACE_RADIUS + 80e3, -0.15],
    ];
    for (const [radius, mu] of cases) {
      const tsl = num(evaluateShaderNode(depthToSpace(
        float(radius), float(mu), float(SURFACE_RADIUS), float(OPTICS.rayleighScaleHeight),
      )));
      const value = depthToSpaceValue(radius, mu, SURFACE_RADIUS, OPTICS.rayleighScaleHeight);
      assert.ok(
        Math.abs(tsl / value - 1) < 1e-4,
        `r=${radius} mu=${mu}: TSL ${tsl} vs 値版 ${value}`,
      );
    }
  });

  test('sun-path-depth: オゾン層を通る経路長は高度と角度で期待どおり変わる', () => {
    const layerAt = (radius: number, mu: number): number => layerDepthValue(
      radius, mu, SURFACE_RADIUS, OPTICS.ozone!.centerAltitude, OPTICS.ozone!.halfThickness,
    );
    // 層の下から天頂へ抜ける経路は層の厚み 30 km。
    assert.ok(Math.abs(layerAt(SURFACE_RADIUS, 1) - 30e3) < 1, `天頂の層路長 ${layerAt(SURFACE_RADIUS, 1)}`);
    // 層より上から上を向く経路は層を通らない。
    assert.equal(layerAt(SURFACE_RADIUS + 40e3, 1), 0, '層の上から上向きは 0 でない');
    // 層より上から地平線の下を向く経路は、層を 2 度通るので厚みの 2 倍より長い。
    const grazing = layerAt(SURFACE_RADIUS + 40e3, -0.05);
    assert.ok(grazing > 60e3, `層の上からの降りる経路が往復を取らない: ${grazing}`);
    // 同じ点では、層へ斜めに入るほど路長が伸びる。
    assert.ok(layerAt(SURFACE_RADIUS, 0.5) > layerAt(SURFACE_RADIUS, 1), '斜めの経路が伸びない');
  });
}
