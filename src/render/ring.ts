// 物理パラメータから環を描く。環の alpha は TSL で
//   T = exp(-tauNormal / |N.V|)
// と単一散乱を評価して決める。
//
// **帯ごとに違う値はマテリアルではなくジオメトリが運ぶ。** 光学値は頂点属性へ、環軸はモデル
// 行列から引くので、全天体・全帯が RingMaterials の 2 枚を共有できる。
import * as THREE from 'three/webgpu';
import {
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  dot,
  exp,
  float,
  max,
  modelWorldMatrix,
  normalize,
  positionWorld,
  vec3,
  vec4,
} from 'three/tsl';
import { RingArcDef, RingOpticsDef } from '../physics/celestial-body-def';
import { viewRayAt } from './pipeline/view-ray';
import type { SunLight } from './pipeline/sun-light';
import type { BodyShadow } from './pipeline/shadow/body-shadow';
import type { FloatNode, Vec3Node } from './tsl-types';

// 環粒子の代表アルベド色(線形 RGB)。氷と岩の混合で、可視域では中性よりわずかに黄色い。
const RING_COLOR: readonly [number, number, number] = [0.72, 0.68, 0.58];

// 環の見た目は XY 平面で組み、この回転で環面(モデル座標の XZ 平面)へ寝かせる。
export const RING_TILT = -Math.PI / 2;
const D2R = Math.PI / 180;
const FOUR_PI = 4 * Math.PI;
const MU_MIN = 0.015;

// 帯 1 本ぶんの光学値を運ぶ頂点属性(x = 光学的厚み、y = 単散乱アルベド、z = 位相 g)。
const RING_OPTICS_ATTRIBUTE = 'ringOptics';
// 線として描く帯だけが持つ、画面上の被覆率。
const RING_COVERAGE_ATTRIBUTE = 'ringCoverage';

export interface RingVisual {
  readonly object: THREE.Object3D;
  // この表示物が組んだ geometry を解放する。object をシーンから外すのは呼び出し側が行う。
  readonly dispose: () => void;
}

// 線として描く帯。1px 未満へ痩せたぶんの減光を setCoverage で受ける。
export interface RingLineVisual extends RingVisual {
  readonly setCoverage: (coverage: number) => void;
}

// 光学的厚みのスケールが一定な扇形。start/length は [rad]。
interface RingSector {
  readonly start: number;
  readonly length: number;
  readonly scale: number;
}

// annulus/line 共通の光学TSLグラフ。coverage は帯の画面上被覆率(1px未満の細帯を
// 減光するための係数)で、面・線どちらのジオメトリへ載せても解釈は同じ。
function ringOpticsNodes(
  coverage: FloatNode, bodyShadow: BodyShadow, sunLight: SunLight,
): { colorNode: Vec3Node; opacityNode: FloatNode } {
  const optics = THREE.TSL.attribute(RING_OPTICS_ATTRIBUTE, 'vec3') as Vec3Node;
  const tauNormal = optics.x as FloatNode;
  const albedo = optics.y as FloatNode;
  const phaseG = optics.z as FloatNode;

  // 恒星の向きと、そのフラグメントが受けている放射照度。天体表面と同じ 1 か所から引くので、
  // 環だけが別の明るさ基準に乗ることはない。
  const toSun = sunLight.position.sub(positionWorld);
  const sunDirection: Vec3Node = normalize(toSun);
  const sunIrradiance: FloatNode = sunLight.intensity.div(max(dot(toSun, toSun), 1));

  // 面から視点へ向かう向き = 視線の逆向き。**「カメラ位置から引く」形は透視投影でしか成り立たない**
  // ので、画面空間のパスと同じ器(pipeline/view-ray.ts)から取って world へ回す。
  const viewDirection = cameraWorldMatrix.mul(vec4(viewRayAt(cameraProjectionMatrixInverse).direction.negate(), 0)).xyz;
  // RingGeometry の面法線だけでなく、側壁を持つ拡散環でも環面に垂直な
  // normal optical depth を評価するため、常に物理的な環軸を使う。**帯のジオメトリは XY 平面へ
  // 組んで RING_TILT で寝かせてあるので、メッシュのローカル +Z がそのまま環面の法線。**
  const ringAxis = normalize(modelWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz);
  const muView = max(dot(ringAxis, viewDirection).abs(), MU_MIN);
  const muSun = max(dot(ringAxis, sunDirection).abs(), MU_MIN);
  const tauView = tauNormal.div(muView);
  const tauSun = tauNormal.div(muSun);
  const transmittance = exp(tauView.negate());
  const baseExtinction = float(1).sub(transmittance);
  const extinction = baseExtinction.mul(coverage);

  // 直射散乱が受ける影。本体も他の天体も、影パスの受け手と同じ 1 つの関数から引く
  // ので、境界は半影の幅でぼける。**環の帯は源から外す** — 環のフラグメントは自分が乗って
  // いる帯の平面上に居るため、含めると自分自身の影で刃こぼれする。
  const directLight = bodyShadow.transmittance(positionWorld);

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
    colorNode: vec3(RING_COLOR[0], RING_COLOR[1], RING_COLOR[2]).mul(radiance),
    opacityNode: extinction,
  };
}

// 環の帯が使うマテリアル。全天体・全帯で共有するので、作るのも解放するのも 1 か所。
export class RingMaterials {
  // annulus と annular prism。半透明で深度は書かない。
  public readonly surface: THREE.MeshBasicNodeMaterial;
  // 1px未満に痩せる細帯はラスタライズで面のまま描くと消えうるので、常にこの線1本で表す
  // (coverage が被覆率ぶん減光するので、遠方ほど濃くなることはない)。
  public readonly line: THREE.LineBasicNodeMaterial;

  // bodyShadow と sunLight は、帯が直射散乱の影と明るさを引く先。
  public constructor(bodyShadow: BodyShadow, sunLight: SunLight) {
    // 面は帯の幅がそのまま画面へ出るので、被覆率は常に 1。
    const surfaceOptics = ringOpticsNodes(float(1), bodyShadow, sunLight);
    this.surface = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.surface.colorNode = surfaceOptics.colorNode;
    this.surface.opacityNode = surfaceOptics.opacityNode;

    const coverage = THREE.TSL.attribute(RING_COVERAGE_ATTRIBUTE, 'float') as FloatNode;
    const lineOptics = ringOpticsNodes(coverage, bodyShadow, sunLight);
    this.line = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
    this.line.colorNode = lineOptics.colorNode;
    this.line.opacityNode = lineOptics.opacityNode;
  }

  public dispose(): void {
    this.surface.dispose();
    this.line.dispose();
  }
}

// 帯の光学値を全頂点へ焼く。**物理的にありえない値はここで丸める** — グラフは属性を素通しで
// 使うので、帯を組むときが最後の関門になる。
function bakeRingOptics(geometry: THREE.BufferGeometry, optics: RingOpticsDef): void {
  const count = geometry.getAttribute('position').count;
  const values = new Float32Array(count * 3);
  const tauNormal = Math.max(0, optics.normalOpticalDepth);
  const albedo = Math.max(0, Math.min(1, optics.singleScatteringAlbedo));
  const phaseG = Math.max(-0.999, Math.min(0.999, optics.phaseG));
  for (let i = 0; i < count; i++) {
    values[i * 3] = tauNormal;
    values[i * 3 + 1] = albedo;
    values[i * 3 + 2] = phaseG;
  }
  geometry.setAttribute(RING_OPTICS_ATTRIBUTE, new THREE.BufferAttribute(values, 3));
}

// 角度 [deg] を 0 以上 360 未満へ折り返す。
function wrapDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// 帯を、アークの重なりが変わらない扇形へ切った並び。アークが無ければ全周 1 つ。
function sectorParts(arcs: readonly RingArcDef[] | undefined): readonly RingSector[] {
  if (arcs === undefined || arcs.length === 0) return [{ start: 0, length: Math.PI * 2, scale: 1 }];
  // 全アークの端点で全周を切る。
  const bounds = [0, 360];
  for (const arc of arcs) bounds.push(wrapDeg(arc.fromDeg), wrapDeg(arc.toDeg));
  const sorted = [...new Set(bounds)].sort((a, b) => a - b);
  // 扇形ごとに、その中点を覆うアーク(0° を跨ぐものも含む)のスケールを掛け合わせる。
  const parts: RingSector[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    const mid = (from + to) * 0.5;
    let scale = 1;
    for (const arc of arcs) {
      const a = wrapDeg(arc.fromDeg);
      const b = wrapDeg(arc.toDeg);
      if (a <= b ? mid >= a && mid < b : mid >= a || mid < b) scale *= arc.opticalDepthScale;
    }
    parts.push({ start: from * D2R, length: (to - from) * D2R, scale });
  }
  return parts.length > 0 ? parts : [{ start: 0, length: Math.PI * 2, scale: 1 }];
}

// 扇形ごとの表示物を 1 つへ束ねる。1 つしかなければ、余計な階層を挟まずそのまま返す。
function combineSectors(visuals: readonly RingVisual[]): RingVisual {
  if (visuals.length === 1) return visuals[0]!;
  const group = new THREE.Group();
  for (const visual of visuals) group.add(visual.object);
  return {
    object: group,
    dispose: () => { for (const visual of visuals) visual.dispose(); },
  };
}

// 扇形ごとの線を 1 つへ束ねる。被覆率は帯ぜんぶで同じなので、全扇形へ配る。
function combineLineSectors(visuals: readonly RingLineVisual[]): RingLineVisual {
  return {
    ...combineSectors(visuals),
    setCoverage: (coverage) => { for (const visual of visuals) visual.setCoverage(coverage); },
  };
}

// 帯 1 本ぶんの面メッシュ。半径は「本体半径 = 1」単位で受ける。
function buildAnnulusMesh(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  thetaStart: number,
  thetaLength: number,
  materials: RingMaterials,
): RingVisual {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1, thetaStart, thetaLength);
  // **属性の並びを prism と揃える** — ジオメトリの鍵が一致して、シェーダグラフの構築が 1 回で済む。
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  bakeRingOptics(geo, optics);
  const mesh = new THREE.Mesh(geo, materials.surface);
  mesh.rotation.x = RING_TILT;
  return { object: mesh, dispose: () => geo.dispose() };
}

/** 薄い環。アークは非重複sectorへ分割するため、実効tauが二重合成されない。 */
export function createAnnulusRing(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  materials: RingMaterials,
  arcs?: readonly RingArcDef[],
): RingVisual {
  return combineSectors(sectorParts(arcs).map((part) => buildAnnulusMesh({
    ...optics,
    normalOpticalDepth: optics.normalOpticalDepth * part.scale,
  }, innerRadius, outerRadius, part.start, part.length, materials)));
}

// 帯 1 本ぶんの線分。半径は「本体半径 = 1」単位で受け、segments が円弧の分割数になる。
function buildLineRingSegment(
  optics: RingOpticsDef,
  radius: number,
  thetaStart: number,
  thetaLength: number,
  segments: number,
  materials: RingMaterials,
): RingLineVisual {
  // 円弧上の点列を XY 平面に置く(Z は 0)。
  const positions = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = thetaStart + (i / segments) * thetaLength;
    positions[i * 3] = Math.cos(a) * radius;
    positions[i * 3 + 1] = Math.sin(a) * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  bakeRingOptics(geo, optics);
  const coverages = new Float32Array(segments + 1).fill(1);
  const coverageAttribute = new THREE.BufferAttribute(coverages, 1);
  geo.setAttribute(RING_COVERAGE_ATTRIBUTE, coverageAttribute);
  const line = new THREE.Line(geo, materials.line);
  line.rotation.x = RING_TILT;
  return {
    object: line,
    setCoverage: (coverage) => {
      if (coverages[0] === coverage) return;
      coverages.fill(coverage);
      coverageAttribute.needsUpdate = true;
    },
    dispose: () => geo.dispose(),
  };
}

/** 実幅が細い環の1px前後表示。アークは非重複sectorへ分割するため、実効tauが二重合成されない。 */
export function createRingLine(
  optics: RingOpticsDef,
  radius: number,
  materials: RingMaterials,
  arcs?: readonly RingArcDef[],
): RingLineVisual {
  return combineLineSectors(sectorParts(arcs).map((part) => buildLineRingSegment({
    ...optics,
    normalOpticalDepth: optics.normalOpticalDepth * part.scale,
  }, radius, part.start, part.length, part.length >= Math.PI * 1.9 ? 256 : 32, materials)));
}

// 内径・外径・高さを持つ角柱状の環(XY 平面に置き、Z が厚み)。上下の面と内外の側壁を張る。
function annularPrism(innerRadius: number, outerRadius: number, height: number): THREE.BufferGeometry {
  const segments = 128;
  const positions: number[] = [];
  const indices: number[] = [];
  // 下面(layer 0)と上面(layer 1)に、内周・外周の点を交互に並べる。
  for (let layer = 0; layer < 2; layer++) {
    const z = layer === 0 ? -height * 0.5 : height * 0.5;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * innerRadius, Math.sin(a) * innerRadius, z);
      positions.push(Math.cos(a) * outerRadius, Math.sin(a) * outerRadius, z);
    }
  }
  // 区間ごとに上面・下面・外壁・内壁の 4 面を 2 三角形ずつ張る。
  const ringIndex = (layer: number, i: number, outer: boolean): number =>
    layer * segments * 2 + ((i + segments) % segments) * 2 + (outer ? 1 : 0);
  for (let i = 0; i < segments; i++) {
    const n = (i + 1) % segments;
    const ti = ringIndex(1, i, false);
    const tn = ringIndex(1, n, false);
    const oi = ringIndex(1, i, true);
    const on = ringIndex(1, n, true);
    const bi = ringIndex(0, i, false);
    const bn = ringIndex(0, n, false);
    const boi = ringIndex(0, i, true);
    const bon = ringIndex(0, n, true);
    indices.push(oi, on, tn, oi, tn, ti, bi, bn, bon, bi, bon, boi);
    indices.push(oi, boi, bon, oi, bon, on, ti, tn, bn, ti, bn, bi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/** 拡散環。扁平球ではなく内径を持つannular prismとして構築する。 */
export function createTorusRing(
  optics: RingOpticsDef,
  innerRadius: number,
  outerRadius: number,
  thickness: number,
  materials: RingMaterials,
): RingVisual {
  const geo = annularPrism(innerRadius, outerRadius, thickness);
  bakeRingOptics(geo, optics);
  const mesh = new THREE.Mesh(geo, materials.surface);
  mesh.rotation.x = RING_TILT;
  return { object: mesh, dispose: () => geo.dispose() };
}
