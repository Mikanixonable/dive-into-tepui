// 物理パラメータから環を描く。環のalphaは固定値ではなく、TSLで
//   T = exp(-tauNormal / |N.V|)
// と単一散乱を評価する。全てのThree importはWebGPU entry pointから行う。
import * as THREE from 'three/webgpu';
import {
  and,
  cameraPosition,
  dot,
  exp,
  float,
  length,
  lessThan,
  max,
  normalize,
  positionWorld,
  select,
  sub,
  uniform,
  vec3,
} from 'three/tsl';
import { RingArcDef, RingOpticsDef } from '../physics/solar-system';
import type { FloatNode, Vec3Node } from './tsl-types';

const RING_TILT = -Math.PI / 2;
const D2R = Math.PI / 180;
const FOUR_PI = 4 * Math.PI;
const MU_MIN = 0.015;
const RADIANCE_SCALE = 0.72;

export type RingVisualState = {
  readonly bodyCenter: THREE.Vector3;
  readonly bodyRadius: number;
  readonly sunDirection: THREE.Vector3;
  readonly cameraPosition: THREE.Vector3;
  readonly ringAxis: THREE.Vector3;
  readonly coverage: number;
};

export type RingVisual = {
  readonly object: THREE.Object3D;
  readonly sync: (state: RingVisualState) => void;
};

function colorNode(color: readonly [number, number, number]): Vec3Node {
  return vec3(color[0], color[1], color[2]);
}

// annulus/line 共通の光学TSLグラフ。coverage は帯の画面上被覆率(1px未満の細帯を
// 減光するための係数)で、面・線どちらのジオメトリへ載せても解釈は同じ。
function ringOpticsNodes(baseColor: Vec3Node, optics: RingOpticsDef): {
  colorNode: Vec3Node;
  opacityNode: FloatNode;
  sync: (state: RingVisualState) => void;
} {
  const bodyCenter = uniform(new THREE.Vector3());
  const bodyRadius = uniform(1);
  const sunDirection = uniform(new THREE.Vector3(1, 0, 0));
  const tauNormal = uniform(Math.max(0, optics.normalOpticalDepth));
  const albedo = uniform(Math.max(0, Math.min(1, optics.singleScatteringAlbedo)));
  const phaseG = uniform(Math.max(-0.999, Math.min(0.999, optics.phaseG)));
  const coverage = uniform(1);
  const ringAxis = uniform(new THREE.Vector3(0, 1, 0));

  const viewDirection = normalize(sub(cameraPosition, positionWorld));
  // RingGeometry の面法線だけでなく、側壁を持つ拡散環でも環面に垂直な
  // normal optical depth を評価するため、常に物理的な環軸を使う。
  const muView = max(dot(ringAxis, viewDirection).abs(), MU_MIN);
  const muSun = max(dot(ringAxis, sunDirection).abs(), MU_MIN);
  const tauView = tauNormal.div(muView);
  const tauSun = tauNormal.div(muSun);
  const transmittance = exp(tauView.negate());
  const baseExtinction = float(1).sub(transmittance);
  const extinction = baseExtinction.mul(coverage);

  // 天体球がフラグメントと太陽の間にあるときは直射散乱を遮る。
  const fromBody = sub(positionWorld, bodyCenter);
  const alongSunRay = dot(fromBody, sunDirection);
  const closestToBody = sub(fromBody, sunDirection.mul(alongSunRay));
  const shadowDistance = length(closestToBody);
  const inBodyShadow = and(lessThan(alongSunRay, 0), lessThan(shadowDistance, bodyRadius));
  const directLight = select(inBodyShadow, float(0), float(1));

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
    .mul(directLight)
    .mul(RADIANCE_SCALE);
  // 通常alpha合成では color * alpha が画面へ寄与する。coverage を含まない
  // baseExtinction で割ることで、散乱輝度にもcoverageが一度だけ掛かる。
  const safeBaseExtinction = max(baseExtinction, 0.001);

  return {
    colorNode: baseColor.mul(scattering.div(safeBaseExtinction)),
    opacityNode: extinction,
    sync: (state) => {
      bodyCenter.value.copy(state.bodyCenter);
      bodyRadius.value = state.bodyRadius;
      sunDirection.value.copy(state.sunDirection).normalize();
      coverage.value = state.coverage;
      ringAxis.value.copy(state.ringAxis).normalize();
    },
  };
}

function physicalMaterial(baseColor: Vec3Node, optics: RingOpticsDef): { material: THREE.MeshBasicNodeMaterial; sync: (state: RingVisualState) => void } {
  const { colorNode: color, opacityNode, sync } = ringOpticsNodes(baseColor, optics);
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
function lineOpticsMaterial(baseColor: Vec3Node, optics: RingOpticsDef): { material: THREE.LineBasicNodeMaterial; sync: (state: RingVisualState) => void } {
  const { colorNode: color, opacityNode, sync } = ringOpticsNodes(baseColor, optics);
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
  return { object: group, sync: (state) => visuals.forEach((visual) => visual.sync(state)) };
}

function buildAnnulusMesh(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  thetaStart: number,
  thetaLength: number,
): RingVisual {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1, thetaStart, thetaLength);
  const { material, sync } = physicalMaterial(colorNode(optics.color), optics);
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = RING_TILT;
  return { object: mesh, sync };
}

/** 薄い環。アークは非重複sectorへ分割するため、実効tauが二重合成されない。 */
export function createAnnulusRing(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  arcs?: readonly RingArcDef[],
): RingVisual {
  const visuals = sectorParts(arcs).map((part) => buildAnnulusMesh({
    ...optics,
    normalOpticalDepth: optics.normalOpticalDepth * part.scale,
  }, innerRadius, outerRadius, part.start, part.length));
  return visuals.length === 1 ? visuals[0]! : combineVisuals(visuals);
}

function buildLineRingSegment(
  optics: RingOpticsDef,
  radius: number,
  thetaStart: number,
  thetaLength: number,
  segments: number,
): RingVisual {
  const positions = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = thetaStart + (i / segments) * thetaLength;
    positions[i * 3] = Math.cos(a) * radius;
    positions[i * 3 + 1] = Math.sin(a) * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const { material, sync } = lineOpticsMaterial(colorNode(optics.color), optics);
  const line = new THREE.Line(geo, material);
  line.rotation.x = RING_TILT;
  return { object: line, sync };
}

/** 実幅が細い環の1px前後表示。アークは非重複sectorへ分割するため、実効tauが二重合成されない。 */
export function createRingLine(
  optics: RingOpticsDef,
  radius: number,
  arcs?: readonly RingArcDef[],
): RingVisual {
  const visuals = sectorParts(arcs).map((part) => buildLineRingSegment({
    ...optics,
    normalOpticalDepth: optics.normalOpticalDepth * part.scale,
  }, radius, part.start, part.length, part.length >= Math.PI * 1.9 ? 256 : 32));
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
): RingVisual {
  const geo = annularPrism(innerRadius, outerRadius, thickness);
  const { material, sync } = physicalMaterial(colorNode(optics.color), optics);
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = RING_TILT;
  return { object: mesh, sync };
}
