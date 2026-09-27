// 軌道分析パネルがプロットする点列(高度タブ・接近タブ・投影タブ)を、既存の伝播・外挿の
// 仕組みから導出する。距離は [m]、時間は [s]、角度は内部では [rad](公開する relIncDeg だけ [deg])。
import { strongestAttractor } from '../../../physics/attractor';
import { orbitalElementsOf, semiMajorFromPeriod } from '../../../physics/elements';
import type { OrbitalElements } from '../../../physics/elements';
import { latLonOf } from '../../../physics/body-orientation';
import { KinematicState } from '../../../physics/kinematic-state';
import { Vec3, dot, len, sub } from '../../../math/vec3';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { CelestialEntity } from '../../celestial/celestial-entity/celestial-entity';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { OrbitReference } from '../../orbit-reference';
import { relativeInclinationDeg } from '../../orbit-info';
import type { CelestialBody } from '../../../physics/celestial-body';

interface AltitudeSample { readonly t: number; readonly alt: number }

interface AltitudeSeries {
  readonly samples: readonly AltitudeSample[];
  readonly currentAlt: number;
  readonly truncated: boolean;
}

interface ApproachSample { readonly x: number; readonly y: number }

interface ApproachSeries {
  // null は「ここで線が切れる」印 — 位相差の折り返しをまたぐ隣り合う点の間に挟まる。
  readonly samples: readonly (ApproachSample | null)[];
  readonly relIncDeg: number;
  readonly truncated: boolean;
}

// 接近タブのターゲット側の伝播経路は種別ごとに違う(艦・基地は predicted、天体は
// その運動)。ラグランジュ点など質量を持たない対象は period が求まらず
// approachSeries が null を返すので、この union に含めない。
export type ApproachTargetSource =
  | { readonly kind: 'entity'; readonly entity: DynamicEntity }
  | { readonly kind: 'celestialBody'; readonly body: CelestialBody };

// center 相対の高度。
function altitudeOf(state: KinematicState, centerState: KinematicState, center: CelestialBody): number {
  return len(sub(state.r, centerState.r)) - center.def.radius;
}

// now から spanSec 先までを sampleCount 等分した各時刻(両端含む sampleCount+1 回)で
// sampleAt を評価した点列を返す。sampleAt が null を返した時点、あるいは区間・個数が
// 不正なときは打ち切り(truncated)— 外挿できない先を 0/NaN で埋めない。
function sampleSpan<S>(
  now: number,
  spanSec: number,
  sampleCount: number,
  sampleAt: (t: number) => S | null,
): { samples: S[]; truncated: boolean } {
  const samples: S[] = [];
  if (spanSec <= 0 || sampleCount <= 0 || !isFinite(spanSec) || !Number.isFinite(sampleCount)) {
    return { samples, truncated: true };
  }
  let truncated = false;
  for (let i = 0; i <= sampleCount; i++) {
    const sample = sampleAt(now + (i * spanSec) / sampleCount);
    if (sample === null) { truncated = true; break; }
    samples.push(sample);
  }
  return { samples, truncated };
}

// 隣り合う点で jumped が真になる箇所の間へ null(線が切れる印)を挟む。
function insertBreaks<S>(points: readonly S[], jumped: (prev: S, next: S) => boolean): (S | null)[] {
  const out: (S | null)[] = [];
  let prev: S | null = null;
  for (const p of points) {
    if (prev !== null && jumped(prev, p)) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

// 高度タブ: 現在時刻(now)から spanSec 先までを sampleCount 等分した各時刻の、reference が示す
// 基準天体からの高度。reference の解決は呼び出し側の責務で、ここでは渡された基準をそのまま使い、
// strongestAttractor を呼び直さない。
// reference が重力中心を持たない(attractor === null)場合は高度が定義できないので null。
// 予測が外挿できず null が返った時刻で打ち切り、それより先のサンプルは作らない(0/NaN で
// 埋めない)。
export function altitudeSeries(
  entity: DynamicEntity,
  reference: OrbitReference,
  celestialBodies: CelestialBodies,
  now: number,
  spanSec: number,
  sampleCount: number,
): AltitudeSeries | null {
  const center = reference.attractor;
  if (center === null) return null;
  const currentAlt = altitudeOf(entity.motion.state, reference.state, center);
  const { samples, truncated } = sampleSpan(now, spanSec, sampleCount, (t) => {
    const state = entity.motion.stateAt(t, celestialBodies);
    if (state === null) return null;
    return { t: t - now, alt: altitudeOf(state, celestialBodies.stateAt(center.id, t), center) };
  });
  return { samples, currentAlt, truncated };
}

// (-pi, pi] へ畳んだ角度差。
function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

// C を中心とする target の軌道基底(pHat/qHat, target の hHat 由来)上での、position の位相角
// (真近点角と同じ向き — trueAnomalyAt と同じ atan2(qHat 成分, pHat 成分))。
function phaseAngleOn(el: OrbitalElements, positionRelCenter: Vec3): number {
  return Math.atan2(dot(positionRelCenter, el.qHat), dot(positionRelCenter, el.pHat));
}

// ターゲット(target)の状態と軌道要素を、他の対象と同じ形(状態取得関数 + 軌道要素)へ揃える。
export function resolveTarget(
  target: ApproachTargetSource, celestialBodies: CelestialBodies, now: number,
): { stateAt: (t: number) => KinematicState | null; currentR: KinematicState['r'] } {
  // 艦・基地は predicted(将来は外挿できないことがある)、天体は自身の運動(常に解析的に解ける)。
  if (target.kind === 'entity') {
    return {
      stateAt: (t) => target.entity.motion.stateAt(t, celestialBodies),
      currentR: target.entity.motion.state.r,
    };
  }
  return {
    stateAt: (t) => celestialBodies.stateAt(target.body.id, t),
    currentR: target.body.stateAt(now).r,
  };
}

// ship と target が同じ主天体を周回しているならその天体、別々の天体を回っているなら null。
// 位相差は共通の主天体まわりでしか測れないので、これが接近タブの成立条件そのものになる。
export function sharedAttractor(
  ship: DynamicEntity,
  target: ApproachTargetSource,
  attractors: readonly CelestialBody[],
  celestialBodies: CelestialBodies,
  now: number,
): CelestialBody | null {
  const targetR = resolveTarget(target, celestialBodies, now).currentR;
  const shipCenter = strongestAttractor(ship.motion.state.r, attractors, now);
  return shipCenter.id === strongestAttractor(targetR, attractors, now).id ? shipCenter : null;
}

// 接近タブ: ship と target が同じ主天体 C を周回しているときだけ、C まわりの位相差を
// 「target と同じ周期の真円軌道」の弧長へ換算した水平距離と、相対高度の点列を返す。
//
// center が一致した後に求める selfEl/targetEl の hHat が、そのまま relIncDeg の材料になる。
//
// 位相差の符号は target の hHat まわり(pHat→qHat の向き。trueAnomalyAt と同じ基底)で取り、
// ship の位相角から target の位相角を引いた差を (-pi, pi] へ折り返す — 正 = target から見て
// ship が前方(orbital motion の向き)にいる。折り返しをまたぐ隣り合う点の間には null を
// 挟んで、そこで線が切れることを示す — 折り返しは半周ぶんの跳びなので、繋ぐと軌道上に
// 存在しない水平な線が引かれてしまう。
//
// target の period が求まらない(双曲線、要素が解けない、質量を持たない対象)場合は null。
export function approachSeries(
  ship: DynamicEntity,
  target: ApproachTargetSource,
  attractors: readonly CelestialBody[],
  celestialBodies: CelestialBodies,
  now: number,
  spanSec: number,
  sampleCount: number,
): ApproachSeries | null {
  const center = sharedAttractor(ship, target, attractors, celestialBodies, now);
  if (center === null) return null;
  const resolved = resolveTarget(target, celestialBodies, now);

  const selfEl = ship.motion.orbitalElementsAround(center, now);
  const targetEl = target.kind === 'entity'
    ? target.entity.motion.orbitalElementsAround(center, now)
    : orbitalElementsOf(target.body.stateAt(now), center, now);
  if (selfEl === null || targetEl === null || !isFinite(targetEl.period)) return null;

  const rCirc = semiMajorFromPeriod(targetEl.period, center.def.mu);
  const relIncDeg = relativeInclinationDeg(selfEl.hHat, targetEl.hHat);

  // どちらかが外挿できなくなった時点で打ち切る。
  const { samples: points, truncated } = sampleSpan(now, spanSec, sampleCount, (t) => {
    const shipState = ship.motion.stateAt(t, celestialBodies);
    const targetState = resolved.stateAt(t);
    if (shipState === null || targetState === null) return null;
    const centerState = celestialBodies.stateAt(center.id, t);
    const shipRel = sub(shipState.r, centerState.r);
    const targetRel = sub(targetState.r, centerState.r);
    // 高度どうしの差なので、両者から引く天体半径は打ち消し合う。
    return {
      theta: wrapAngle(phaseAngleOn(targetEl, shipRel) - phaseAngleOn(targetEl, targetRel)),
      relAlt: len(shipRel) - len(targetRel),
    };
  });
  // 隣り合う位相差が半周より大きく跳んだなら、それは折り返しであって実際の移動ではない。
  const samples = insertBreaks(points, (a, b) => Math.abs(b.theta - a.theta) > Math.PI)
    .map((p): ApproachSample | null => (p === null ? null : { x: rCirc * p.theta, y: p.relAlt }));
  return { samples, relIncDeg, truncated };
}

interface ProjectionSample { readonly latDeg: number; readonly lonDeg: number }

interface ProjectionSeries {
  readonly current: ProjectionSample;
  // null は経度 ±180° をまたぐ跳びの印(接近タブの位相折り返しと同じ扱い)。
  readonly samples: readonly (ProjectionSample | null)[];
  readonly truncated: boolean;
}

// state(中心天体相対ではなく ECI)を中心天体の時刻 t での自転を通じて緯度経度へ変換する。
// 中心天体が自転モデルを持たなければ null。
function projectionSampleAt(
  state: KinematicState, centerState: KinematicState, center: CelestialEntity, t: number,
): ProjectionSample | null {
  const orientation = center.motion.orientationAt(t);
  if (orientation === null) return null;
  const { latRad, lonRad } = latLonOf(sub(state.r, centerState.r), orientation.axis, orientation.spinAngle);
  return { latDeg: (latRad * 180) / Math.PI, lonDeg: (lonRad * 180) / Math.PI };
}

// 投影タブ: stateAt が返す位置を、center の自転を通じて緯度経度へ変換した点列。
// 中心天体が自転モデルを持たない場合は null。
export function projectionSeries(
  stateAt: (t: number) => KinematicState | null,
  center: CelestialEntity,
  now: number,
  spanSec: number,
  sampleCount: number,
): ProjectionSeries | null {
  // 現在時刻の経緯度。中心天体が自転モデルを持たなければここで打ち切る。
  const currentState = stateAt(now);
  if (currentState === null) return null;
  const current = projectionSampleAt(currentState, center.motion.stateAt(now), center, now);
  if (current === null) return null;

  // 未来へ等間隔でサンプリングし、外挿できなくなった時点で打ち切る。
  const { samples: points, truncated } = sampleSpan(now, spanSec, sampleCount, (t) => {
    const state = stateAt(t);
    return state === null ? null : projectionSampleAt(state, center.motion.stateAt(t), center, t);
  });
  // 経度 ±180° をまたぐ跳びは null を挟んで線が切れることを示す。
  const samples = insertBreaks(points, (a, b) => Math.abs(b.lonDeg - a.lonDeg) > 180);
  return { current, samples, truncated };
}
