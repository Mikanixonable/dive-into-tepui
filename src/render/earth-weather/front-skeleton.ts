// 前線骨格の数値評価 — pressure-feature.ts の TSL と同じ式の JS 版。腕は閉塞点(三点)を
// 根元に「半径 r で向きが θ(r) の半直線」として表し、向きは下流(東)から循環の向き
// (両半球で反時計)を正に取る。天気図(tools/cloud-lab)が谷へ繋がる前線を折れ線として
// 引くのに使う。
import { CLOUD_TUNING } from './cloud/cloud-tuning';
import { OCCLUSION_DEPTH } from './pressure-feature';
import type { PressurePlacement } from './tracks';

// 腕の帯が芯側へ届く半径の床(芯の半径の倍率)。TSL 側と同じ値。
export const FRONT_INNER_RADIUS = 0.15;
// 熱帯の渦で温暖の腕が立ち始める閉塞の進み。TSL 側と同じ値。
export const TAIL_WARM_ONSET = 0.02;
export const TAIL_WARM_FULL = 0.3;

const DEGREE = Math.PI / 180;
const RAD = 180 / Math.PI;
// 腕の背骨を折れ線へ切る刻み数。
const SAMPLES = 48;

// 背骨の上の点。緯度・経度 [°]、nx・ny は循環側(+θ、帯の進行側)の法線の東向き・北向き成分。
export interface SpinePoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly nx: number;
  readonly ny: number;
}

// 前線の腕 1 本の背骨。kind は描き分け(寒冷・温暖・閉塞)そのままの種別。
export interface FrontSpine {
  readonly kind: 'cold' | 'warm' | 'occluded';
  readonly points: readonly SpinePoint[];
}

type Vec3 = readonly [number, number, number];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1e-9;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);
const smoothstep = (x: number, e0: number, e1: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// 配置 placement(表面半径 surfaceRadius)の谷が持つ前線の背骨の束。返るのは帯ではなく
// 背骨の折れ線 — 帯の幅と滲みは描き側が決める。前線を持たない配置では空。
export function frontSpinesOf(
  placement: PressurePlacement, surfaceRadius: number,
): readonly FrontSpine[] {
  if (placement.fronts === undefined) return [];
  const tuning = CLOUD_TUNING;
  const cosLat = Math.cos(placement.latitude);
  const cosLon = Math.cos(placement.longitude);
  const center: Vec3 = [
    cosLat * Math.sin(placement.longitude), Math.sin(placement.latitude), cosLat * cosLon];
  // 極側と下流(東)の単位接ベクトル — pressure-feature の occlusionFrame と同じ式。
  const hemisphere = Math.sign(center[1]);
  const poleward = norm([
    -center[0] * Math.abs(center[1]), hemisphere - center[1] * Math.abs(center[1]),
    -center[2] * Math.abs(center[1])]);
  const downstream = norm(cross([0, 1, 0], center));
  const coreRad = placement.radius / surfaceRadius;
  const triple = (placement.occlusion ?? 0) * tuning.frontTripleRadius.value;
  // 腕の根元の向き — 三点が出ると寒冷・温暖とも三点の向きへ寄り、3 本が同じ点へ繋がる。
  const rootJoin = smoothstep(triple, 0, 0.2);
  const coldRoot = tuning.frontColdAngleDeg.value
    + (tuning.frontTripleAngleDeg.value - tuning.frontColdAngleDeg.value) * rootJoin;
  const warmRoot = tuning.frontWarmAngleDeg.value
    + (tuning.frontTripleAngleDeg.value - tuning.frontWarmAngleDeg.value) * rootJoin;

  const pointAt = (r: number, angleDeg: number): SpinePoint => {
    const a = angleDeg * DEGREE;
    const chord = r * coreRad;
    const d = norm([
      center[0] + chord * (Math.cos(a) * downstream[0] + Math.sin(a) * poleward[0]),
      center[1] + chord * (Math.cos(a) * downstream[1] + Math.sin(a) * poleward[1]),
      center[2] + chord * (Math.cos(a) * downstream[2] + Math.sin(a) * poleward[2])]);
    const east = norm(cross([0, 1, 0], d));
    const north = cross(d, east);
    // 循環側(+θ)の法線 — その点での +θ の向きを、点の局所の東・北へ写す。
    const n: Vec3 = [
      -Math.sin(a) * downstream[0] + Math.cos(a) * poleward[0],
      -Math.sin(a) * downstream[1] + Math.cos(a) * poleward[1],
      -Math.sin(a) * downstream[2] + Math.cos(a) * poleward[2]];
    return {
      latitude: Math.asin(Math.min(Math.max(d[1], -1), 1)) * RAD,
      longitude: Math.atan2(d[0], d[2]) * RAD,
      nx: dot(n, east),
      ny: dot(n, north),
    };
  };
  const spine = (
    kind: FrontSpine['kind'], angleAt: (r: number) => number, rMin: number, rMax: number,
  ): FrontSpine => ({
    kind,
    points: Array.from({ length: SAMPLES + 1 }, (_, i) => {
      const r = rMin + (rMax - rMin) * i / SAMPLES;
      return pointAt(r, angleAt(r));
    }),
  });
  const progress = (r: number, armLength: number): number =>
    clamp01((r - triple) / Math.max(armLength - triple, 1e-3));

  const isTail = placement.fronts === 'tail';
  const coldLength = (isTail ? tuning.frontTailLength : tuning.frontColdLength).value;
  const spines: FrontSpine[] = [];
  // 寒冷(赤道側)の腕 — 熱帯の渦ではこの腕が赤道側の尾。向きは根元から先端へ曲がる。
  if (coldLength > Math.max(triple, FRONT_INNER_RADIUS)) {
    spines.push(spine(
      'cold',
      r => coldRoot
        + (tuning.frontColdTipAngleDeg.value - coldRoot) * progress(r, coldLength)
          ** tuning.frontColdBend.value,
      Math.max(triple, FRONT_INNER_RADIUS), coldLength));
  }
  // 温暖(極側〜下流)の腕 — 熱帯の渦では温帯化が進むまで立たない。
  const warmGate = isTail
    ? smoothstep(placement.occlusion ?? 0, TAIL_WARM_ONSET, TAIL_WARM_FULL) : 1;
  if (warmGate > 0 && tuning.frontWarmLength.value > Math.max(triple, FRONT_INNER_RADIUS)) {
    spines.push(spine(
      'warm',
      r => warmRoot
        + (tuning.frontWarmTipAngleDeg.value - warmRoot) * progress(r, tuning.frontWarmLength.value)
          ** tuning.frontWarmBend.value,
      Math.max(triple, FRONT_INNER_RADIUS), tuning.frontWarmLength.value));
  }
  // 閉塞の腕 — 三点の向きから内側へ循環の向きへ巻き込む。三点が出るまで無い。
  if (triple > FRONT_INNER_RADIUS) {
    spines.push(spine(
      'occluded',
      r => tuning.frontTripleAngleDeg.value
        + tuning.frontOccSwingDeg.value * clamp01((triple - r) / triple) ** tuning.frontOccBend.value,
      FRONT_INNER_RADIUS, triple));
  }
  return spines;
}

// 配置 placement の谷の前線の帯の強さ 0..1 — 深さに比例し、熱帯の渦の尾は温帯へ
// 近づくにつれ育つ。TSL 側の strength × gate と同じ式。描き側が腕を引くかどうかの目安に使う。
export function frontStrengthOf(placement: PressurePlacement): number {
  const strength = Math.min(placement.depth / OCCLUSION_DEPTH, 1);
  if (placement.fronts !== 'tail') return placement.fronts === 'pair' ? strength : 0;
  const gate = smoothstep(
    Math.abs(placement.latitude) / DEGREE,
    CLOUD_TUNING.frontTailLatitudeStartDeg.value,
    CLOUD_TUNING.frontTailLatitudeFullDeg.value);
  return strength * gate;
}
