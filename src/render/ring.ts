// 物理パラメータから環を描く。環のalphaは固定値ではなく、TSLで
//   T = exp(-tauNormal / |N.V|)
// と単一散乱を評価する。全てのThree importはWebGPU entry pointから行う。
import * as THREE from 'three/webgpu';
import {
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  dot,
  exp,
  float,
  max,
  normalize,
  positionWorld,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { RingArcDef, RingOpticsDef } from '../physics/celestial-body-def';
import { viewRayAt } from './pipeline/view-ray';
import type { SunLight } from './pipeline/sun-light';
import type { SunOcclusion } from './pipeline/sun-occlusion';
import type { FloatNode, Vec3Node } from './tsl-types';

// 環粒子の代表アルベド色(線形 RGB)。氷と岩の混合で、可視域では中性よりわずかに黄色い。
const RING_COLOR: readonly [number, number, number] = [0.72, 0.68, 0.58];

// 環の見た目は XY 平面で組み、この回転で環面(モデル座標の XZ 平面)へ寝かせる。
export const RING_TILT = -Math.PI / 2;
const D2R = Math.PI / 180;
const FOUR_PI = 4 * Math.PI;
const MU_MIN = 0.015;

export type RingVisualState = {
  readonly ringAxis: THREE.Vector3;
  readonly coverage: number;
};

export type RingVisual = {
  readonly object: THREE.Object3D;
  readonly sync: (state: RingVisualState) => void;
  // 自前の geometry/material を解放する。object をシーンから外すのは呼び出し側の責務。
  readonly dispose: () => void;
};

function colorNode(color: readonly [number, number, number]): Vec3Node {
  return vec3(color[0], color[1], color[2]);
}

// 環の代表色をノードにしたもの。全帯で同じ色を使う。
function ringBaseColor(): Vec3Node {
  return colorNode(RING_COLOR);
}

// annulus/line 共通の光学TSLグラフ。coverage は帯の画面上被覆率(1px未満の細帯を
// 減光するための係数)で、面・線どちらのジオメトリへ載せても解釈は同じ。
function ringOpticsNodes(
  baseColor: Vec3Node, optics: RingOpticsDef, sunOcclusion: SunOcclusion, sunLight: SunLight,
): {
  colorNode: Vec3Node;
  opacityNode: FloatNode;
  sync: (state: RingVisualState) => void;
} {
  const tauNormal = uniform(Math.max(0, optics.normalOpticalDepth));
  const albedo = uniform(Math.max(0, Math.min(1, optics.singleScatteringAlbedo)));
  const phaseG = uniform(Math.max(-0.999, Math.min(0.999, optics.phaseG)));
  const coverage = uniform(1);
  const ringAxis = uniform(new THREE.Vector3(0, 1, 0));

  // 恒星の向きと、そのフラグメントが受けている放射照度。天体表面と同じ 1 か所から引くので、
  // 環だけが別の明るさ基準に乗ることはない。
  const toSun = sunLight.position.sub(positionWorld);
  const sunDirection: Vec3Node = normalize(toSun);
  const sunIrradiance: FloatNode = sunLight.intensity.div(max(dot(toSun, toSun), 1));

  // 面から視点へ向かう向き = 視線の逆向き。**「カメラ位置から引く」形は透視投影でしか成り立たない**
  // ので、画面空間のパスと同じ器(pipeline/view-ray.ts)から取って world へ回す。
  const viewDirection = cameraWorldMatrix.mul(vec4(viewRayAt(cameraProjectionMatrixInverse).direction.negate(), 0)).xyz;
  // RingGeometry の面法線だけでなく、側壁を持つ拡散環でも環面に垂直な
  // normal optical depth を評価するため、常に物理的な環軸を使う。
  const muView = max(dot(ringAxis, viewDirection).abs(), MU_MIN);
  const muSun = max(dot(ringAxis, sunDirection).abs(), MU_MIN);
  const tauView = tauNormal.div(muView);
  const tauSun = tauNormal.div(muSun);
  const transmittance = exp(tauView.negate());
  const baseExtinction = float(1).sub(transmittance);
  const extinction = baseExtinction.mul(coverage);

  // 直射散乱が受ける遮蔽。本体の球も他の天体も、遮蔽パスの受け手と同じ 1 つの関数から引く
  // ので、境界は半影の幅でぼける。**環の帯は源から外す** — 環のフラグメントは自分が乗って
  // いる帯の平面上に居るため、含めると自己遮蔽で刃こぼれする。
  const directLight = sunOcclusion.transmittance(positionWorld, {
    rings: false, meshNormal: null, selfViewDistance: null,
  });

  const denominator = float(1).add(phaseG.mul(phaseG)).sub(
    phaseG.mul(float(2).mul(dot(sunDirection.negate(), viewDirection))),
  );
  const phase = float(1).sub(phaseG.mul(phaseG)).div(
    float(FOUR_PI).mul(denominator.sqrt().mul(denominator)),
  );
  const scattering = albedo
    .mul(float(1).sub(exp(tauSun.negate())))
    .mul(exp(tauView.mul(-0.5)))
    .mul(phase.mul(FOUR_PI))
    .mul(directLight);
  // 通常alpha合成では color * alpha が画面へ寄与する。coverage を含まない
  // baseExtinction で割ることで、散乱輝度にもcoverageが一度だけ掛かる。
  const safeBaseExtinction = max(baseExtinction, 0.001);

  // 放射照度を 1/π 倍して輝度へ直す — ランバート面が同じ反射率で返す輝度と揃うので、
  // 本体と環が1つの明るさ基準に乗る。
  const radiance = scattering.div(safeBaseExtinction).mul(sunIrradiance.div(Math.PI));

  return {
    colorNode: baseColor.mul(radiance),
    opacityNode: extinction,
    sync: (state) => {
      coverage.value = state.coverage;
      ringAxis.value.copy(state.ringAxis).normalize();
    },
  };
}

// 面として描く帯のマテリアルと、その状態同期口。半透明で深度は書かない。
function physicalMaterial(
  baseColor: Vec3Node, optics: RingOpticsDef, sunOcclusion: SunOcclusion, sunLight: SunLight,
): { material: THREE.MeshBasicNodeMaterial; sync: (state: RingVisualState) => void } {
  const { colorNode: color, opacityNode, sync } = ringOpticsNodes(baseColor, optics, sunOcclusion, sunLight);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  mat.colorNode = color;
  mat.opacityNode = opacityNode;
  return { material: mat, sync };
}

// 面(annulus)と同じ光学TSLグラフを THREE.Line 用マテリアルへ載せる。1px未満に痩せる
// 細帯はラスタライズで面のまま描くと消えうるので、常にこの線1本で表す(coverage が
// 被覆率ぶん減光するので、遠方ほど濃くなることはない)。
function lineOpticsMaterial(
  baseColor: Vec3Node, optics: RingOpticsDef, sunOcclusion: SunOcclusion, sunLight: SunLight,
): { material: THREE.LineBasicNodeMaterial; sync: (state: RingVisualState) => void } {
  const { colorNode: color, opacityNode, sync } = ringOpticsNodes(baseColor, optics, sunOcclusion, sunLight);
  const mat = new THREE.LineBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  mat.colorNode = color;
  mat.opacityNode = opacityNode;
  return { material: mat, sync };
}

function sectorParts(arcs: readonly RingArcDef[] | undefined): readonly { start: number; length: number; scale: number }[] {
  if (arcs === undefined || arcs.length === 0) return [{ start: 0, length: Math.PI * 2, scale: 1 }];
  const bounds = [0, 360];
  for (const arc of arcs) {
    bounds.push(((arc.fromDeg % 360) + 360) % 360, ((arc.toDeg % 360) + 360) % 360);
  }
  const sorted = [...new Set(bounds)].sort((a, b) => a - b);
  const parts: { start: number; length: number; scale: number }[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    const mid = (from + to) * 0.5;
    let scale = 1;
    for (const arc of arcs) {
      const a = ((arc.fromDeg % 360) + 360) % 360;
      const b = ((arc.toDeg % 360) + 360) % 360;
      if (a <= b ? mid >= a && mid < b : mid >= a || mid < b) scale *= arc.opticalDepthScale;
    }
    parts.push({ start: from * D2R, length: (to - from) * D2R, scale });
  }
  return parts.length > 0 ? parts : [{ start: 0, length: Math.PI * 2, scale: 1 }];
}

function combineVisuals(visuals: readonly RingVisual[]): RingVisual {
  const group = new THREE.Group();
  for (const visual of visuals) group.add(visual.object);
  return {
    object: group,
    sync: (state) => visuals.forEach((visual) => visual.sync(state)),
    dispose: () => visuals.forEach((visual) => visual.dispose()),
  };
}

// 帯 1 本ぶんの面メッシュ。半径は「本体半径 = 1」単位で受ける。
function buildAnnulusMesh(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  thetaStart: number,
  thetaLength: number,
  sunOcclusion: SunOcclusion,
  sunLight: SunLight,
): RingVisual {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1, thetaStart, thetaLength);
  const { material, sync } = physicalMaterial(ringBaseColor(), optics, sunOcclusion, sunLight);
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = RING_TILT;
  return { object: mesh, sync, dispose: () => { geo.dispose(); material.dispose(); } };
}

/** 薄い環。アークは非重複sectorへ分割するため、実効tauが二重合成されない。 */
export function createAnnulusRing(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  sunOcclusion: SunOcclusion,
  sunLight: SunLight,
  arcs?: readonly RingArcDef[],
): RingVisual {
  const visuals = sectorParts(arcs).map((part) => buildAnnulusMesh({
    ...optics,
    normalOpticalDepth: optics.normalOpticalDepth * part.scale,
  }, innerRadius, outerRadius, part.start, part.length, sunOcclusion, sunLight));
  return visuals.length === 1 ? visuals[0]! : combineVisuals(visuals);
}

// 帯 1 本ぶんの線分。半径は「本体半径 = 1」単位で受け、segments が円弧の分割数になる。
function buildLineRingSegment(
  optics: RingOpticsDef,
  radius: number,
  thetaStart: number,
  thetaLength: number,
  segments: number,
  sunOcclusion: SunOcclusion,
  sunLight: SunLight,
): RingVisual {
  const positions = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = thetaStart + (i / segments) * thetaLength;
    positions[i * 3] = Math.cos(a) * radius;
    positions[i * 3 + 1] = Math.sin(a) * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const { material, sync } = lineOpticsMaterial(ringBaseColor(), optics, sunOcclusion, sunLight);
  const line = new THREE.Line(geo, material);
  line.rotation.x = RING_TILT;
  return { object: line, sync, dispose: () => { geo.dispose(); material.dispose(); } };
}

/** 実幅が細い環の1px前後表示。アークは非重複sectorへ分割するため、実効tauが二重合成されない。 */
export function createRingLine(
  optics: RingOpticsDef,
  radius: number,
  sunOcclusion: SunOcclusion,
  sunLight: SunLight,
  arcs?: readonly RingArcDef[],
): RingVisual {
  const visuals = sectorParts(arcs).map((part) => buildLineRingSegment({
    ...optics,
    normalOpticalDepth: optics.normalOpticalDepth * part.scale,
  }, radius, part.start, part.length, part.length >= Math.PI * 1.9 ? 256 : 32, sunOcclusion, sunLight));
  return visuals.length === 1 ? visuals[0]! : combineVisuals(visuals);
}

function annularPrism(innerRadius: number, outerRadius: number, height: number): THREE.BufferGeometry {
  const segments = 128;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let layer = 0; layer < 2; layer++) {
    const z = layer === 0 ? -height * 0.5 : height * 0.5;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * innerRadius, Math.sin(a) * innerRadius, z);
      positions.push(Math.cos(a) * outerRadius, Math.sin(a) * outerRadius, z);
    }
  }
  const ringIndex = (layer: number, i: number, outer: boolean) => layer * segments * 2 + ((i + segments) % segments) * 2 + (outer ? 1 : 0);
  for (let i = 0; i < segments; i++) {
    const n = (i + 1) % segments;
    const ti = ringIndex(1, i, false), tn = ringIndex(1, n, false), oi = ringIndex(1, i, true), on = ringIndex(1, n, true);
    const bi = ringIndex(0, i, false), bn = ringIndex(0, n, false), boi = ringIndex(0, i, true), bon = ringIndex(0, n, true);
    indices.push(oi, on, tn, oi, tn, ti, bi, bn, bon, bi, bon, boi);
    indices.push(oi, boi, bon, oi, bon, on, ti, tn, bn, ti, bn, bi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 拡散環。扁平球ではなく内径を持つannular prismとして構築する。 */
export function createTorusRing(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  thickness: number,
  sunOcclusion: SunOcclusion,
  sunLight: SunLight,
): RingVisual {
  const geo = annularPrism(innerRadius, outerRadius, thickness);
  const { material, sync } = physicalMaterial(ringBaseColor(), optics, sunOcclusion, sunLight);
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = RING_TILT;
  return { object: mesh, sync, dispose: () => { geo.dispose(); material.dispose(); } };
}
