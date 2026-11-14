// 直射日光の大気減衰(render/pipeline/sun-extinction.ts と、大気積分と共有する
// render/pipeline/sun-path-depth.ts)の回帰テスト。CPU 評価で、天頂の解析解・単調性・
// 波長順・高度効果・地平線直下の連続性・空き枠の素通しを見る。地球の光学と大きさは
// src の定義から取り、値をここへ写さない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { test } from '../harness';
import { evaluateShaderNode, type ShaderValue } from './tsl-node-evaluator';
import { SunExtinction } from '../../src/render/pipeline/sun-extinction';
import { SunLight } from '../../src/render/pipeline/sun-light';
import {
  depthToSpace, polarStretchOf, sunPathDepth, sunPathGeometry,
} from '../../src/render/pipeline/sun-path-depth';
import { EARTH, EARTH_ATMOSPHERE_OPTICS, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import type { AtmosphereBody } from '../../src/render/atmosphere';
import type { Vec3Node } from '../../src/render/tsl-types';

const OPTICS = EARTH_ATMOSPHERE_OPTICS;
const SURFACE_RADIUS = R_EARTH_EQ;
const SUN_DISTANCE = 1.5e11;

const vec = (value: ShaderValue): number[] => value as number[];
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

// 太陽を sunDirection の先へ置いた光源と、その光源を見る消光。
function extinctionAt(sunDirection: THREE.Vector3, bodies: readonly AtmosphereBody[]): SunExtinction {
  const sunLight = new SunLight();
  sunLight.set(
    sunDirection.clone().normalize().multiplyScalar(SUN_DISTANCE), 7e8, new THREE.Color(1, 1, 1), 1e26,
  );
  const extinction = new SunExtinction(sunLight);
  extinction.set(bodies);
  return extinction;
}

// 地表の +Y 点から見て、太陽の天頂角余弦が mu になる向き。
const sunDirectionForMu = (mu: number): THREE.Vector3 =>
  new THREE.Vector3(Math.sqrt(1 - mu * mu), mu, 0);

export function register(): void {
  test('sun-extinction: 大気を持たない列では透過率は 1 のまま', () => {
    const extinction = extinctionAt(new THREE.Vector3(0, 1, 0), []);
    const transmittance = vec(evaluateShaderNode(
      extinction.transmittance(pointNode(new THREE.Vector3(0, SURFACE_RADIUS, 0))),
    ));
    assert.deepEqual(transmittance, [1, 1, 1], '空き枠が素通しの 1 になっていない');
  });

  test('sun-extinction: 天頂の太陽では exp(-(β_R·H_R + β_M·H_M)) と一致する', () => {
    const extinction = extinctionAt(new THREE.Vector3(0, 1, 0), [earthAtmosphere()]);
    const transmittance = vec(evaluateShaderNode(
      extinction.transmittance(pointNode(new THREE.Vector3(0, SURFACE_RADIUS, 0))),
    ));
    const expected = (channel: number) => Math.exp(-(
      OPTICS.rayleigh.getComponent(channel) * OPTICS.rayleighScaleHeight
      + OPTICS.mie * OPTICS.mieScaleHeight
    ));
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        Math.abs(transmittance[channel]! / expected(channel) - 1) < 0.01,
        `channel ${channel}: ${transmittance[channel]} vs ${expected(channel)}`,
      );
    }
  });

  test('sun-extinction: 太陽を沈めるほど透過率は下がり、地平線を挟んで連続する', () => {
    const point = new THREE.Vector3(0, SURFACE_RADIUS, 0);
    const mus = [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0.02, 0, -0.01, -0.02, -0.03, -0.05];
    const transmittanceAt = (mu: number): number => {
      const extinction = extinctionAt(sunDirectionForMu(mu), [earthAtmosphere()]);
      const rgb = vec(evaluateShaderNode(extinction.transmittance(pointNode(point))));
      return (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
    };
    let previous = transmittanceAt(mus[0]!);
    for (const mu of mus.slice(1)) {
      const current = transmittanceAt(mu);
      assert.ok(current <= previous * (1 + 1e-9), `mu=${mu} で透過率が増えた: ${previous} -> ${current}`);
      previous = current;
    }
    // 地平線の直上直下で明るさが跳ねない。薄明では勾配そのものが急峻なので、連続性の
    // 検証は微係数が厚みをほとんど動かさない窓で見る。
    const above = transmittanceAt(1e-5);
    const below = transmittanceAt(-1e-5);
    assert.ok(below / above > 0.9 && below / above < 1, `地平線の前後で不連続: ${above} -> ${below}`);
  });

  test('sun-extinction: 地平線付近では赤のほうが透過率が大きい', () => {
    const extinction = extinctionAt(sunDirectionForMu(0), [earthAtmosphere()]);
    const rgb = vec(evaluateShaderNode(
      extinction.transmittance(pointNode(new THREE.Vector3(0, SURFACE_RADIUS, 0))),
    ));
    assert.ok(rgb[0]! > rgb[1]! && rgb[1]! > rgb[2]!, `波長順が乱れている: ${rgb}`);
  });

  test('sun-extinction: 同じ太陽の高さでは、高い点ほど透過率が大きい', () => {
    const extinction = extinctionAt(sunDirectionForMu(0.1), [earthAtmosphere()]);
    const surface = vec(evaluateShaderNode(
      extinction.transmittance(pointNode(new THREE.Vector3(0, SURFACE_RADIUS, 0))),
    ));
    const high = vec(evaluateShaderNode(
      extinction.transmittance(pointNode(new THREE.Vector3(0, SURFACE_RADIUS + 10e3, 0))),
    ));
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(high[channel]! > surface[channel]!, `channel ${channel}: ${high[channel]} <= ${surface[channel]}`);
    }
  });

  test('sun-extinction: 高い点は局所の地平線の下の太陽でも透過率が 0 にならない', () => {
    const point = new THREE.Vector3(0, SURFACE_RADIUS + 2e3, 0);
    // 高度 2km では局所の地平線は真の水平から約 1.6° 下がる。1° 下の太陽はまだ見えている。
    const mu = -Math.sin(THREE.MathUtils.degToRad(1));
    const transmittanceAt = (muValue: number): number => {
      const extinction = extinctionAt(sunDirectionForMu(muValue), [earthAtmosphere()]);
      const rgb = vec(evaluateShaderNode(extinction.transmittance(pointNode(point))));
      return (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
    };
    const near = transmittanceAt(mu);
    const far = transmittanceAt(mu * 2);
    assert.ok(near > 0, `地平線下 1° で透過率が 0 になった`);
    assert.ok(far < near, `沈むほど下がらない: ${near} -> ${far}`);
  });

  test('sun-extinction: 扁平な天体では、極の地表でも天頂の解析解と一致する', () => {
    const shape = EARTH.shape as { equatorRadius: number; polarRadius: number };
    const polarRatio = shape.polarRadius / shape.equatorRadius;
    const body = earthAtmosphere({ polarRatio });
    // 極の地表の点(描画座標では極半径ぶんの高さ)と、その直上の太陽。
    const poleSurface = new THREE.Vector3(0, shape.polarRadius, 0);
    const extinction = extinctionAt(new THREE.Vector3(0, 1, 0), [body]);
    const rgb = vec(evaluateShaderNode(extinction.transmittance(pointNode(poleSurface))));
    const expected = (channel: number) => Math.exp(-(
      OPTICS.rayleigh.getComponent(channel) * OPTICS.rayleighScaleHeight
      + OPTICS.mie * OPTICS.mieScaleHeight
    ));
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        Math.abs(rgb[channel]! / expected(channel) - 1) < 0.01,
        `channel ${channel}: 扁平な天体で地表の厚みがずれた ${rgb[channel]} vs ${expected(channel)}`,
      );
    }
  });

  test('sun-path-depth: 共有関数の光学的厚みは depthToSpace の成分和である', () => {
    const sunDirection = sunDirectionForMu(0.3);
    const sunPosition = sunDirection.clone().multiplyScalar(SUN_DISTANCE);
    const point = new THREE.Vector3(0, SURFACE_RADIUS, 0);
    const atmosphere = {
      center: vec3(0, 0, 0),
      surfaceRadius: float(SURFACE_RADIUS),
      polarAxis: vec3(0, 1, 0),
      polarStretch: float(polarStretchOf(1)),
      rayleigh: vec3(OPTICS.rayleigh.x, OPTICS.rayleigh.y, OPTICS.rayleigh.z),
      rayleighScaleHeight: float(OPTICS.rayleighScaleHeight),
      mie: float(OPTICS.mie),
      mieScaleHeight: float(OPTICS.mieScaleHeight),
    };
    const depth = vec(evaluateShaderNode(sunPathDepth(
      sunPathGeometry(pointNode(point), vec3(sunPosition.x, sunPosition.y, sunPosition.z), atmosphere),
      atmosphere,
    )));
    // グラフと同じ幾何で mu を取る(点と太陽位置だけから決まる)。
    const sunMu = new THREE.Vector3(0, 1, 0).dot(sunPosition.clone().sub(point).normalize());
    const rayleighDepth = evaluateShaderNode(
      depthToSpace(float(SURFACE_RADIUS), float(sunMu), float(SURFACE_RADIUS), float(OPTICS.rayleighScaleHeight)),
    ) as number;
    const mieDepth = evaluateShaderNode(
      depthToSpace(float(SURFACE_RADIUS), float(sunMu), float(SURFACE_RADIUS), float(OPTICS.mieScaleHeight)),
    ) as number;
    for (let channel = 0; channel < 3; channel++) {
      const expected = OPTICS.rayleigh.getComponent(channel) * rayleighDepth + OPTICS.mie * mieDepth;
      assert.ok(
        Math.abs(depth[channel]! / expected - 1) < 1e-3,
        `channel ${channel}: 共有関数の厚みが成分和と違う ${depth[channel]} vs ${expected}`,
      );
    }
  });
}
