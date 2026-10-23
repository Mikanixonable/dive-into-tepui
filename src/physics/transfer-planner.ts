// 遷移候補の求解。出発時刻×飛行時間の格子をランベルト問題で結び、得られたインパルスの
// 列を「Δv × 到着時刻」の候補として返す。直行(0周回)のほか、長い飛行時間で周回を挟む
// 低エネルギー解を同じ格子で拾い、出発・目標の両軌道が近円かつ同面のときは閉形式の
// 二重楕円・大気減速も混ぜる。方式の選択はここでは行わず、候補が方式名を持つ
// (SPEC/PLAN.md「遷移方式」)。大気減速の抗力見積は指数大気での近点通過を一瞬の減速と
// みなす近似で、通過中の速さの変化・基準楕円体の扁平・大気の共回転は省く — 候補を
// 並べる目安であり、実行される軌道は全力学モデルが決める。船の出発前の運動は二体問題
// として要素から伝播し、全力学モデルへの寄りは trajectory-correction.ts が担う。
// THREE/DOM 非依存。
import { add, cross, dot, len, norm, scale, sub, type Vec3 } from '../math/vec3';
import type { CelestialBody } from './celestial-body';
import { type Atmosphere, atmosphericDensity, atmosphericScaleHeight } from './atmosphere';
import { keplerPeriod, orbitalElementsOf, stateOnOrbitAt, type OrbitalElements } from './elements';
import { kinematicState, type KinematicState } from './kinematic-state';
import { solveLambert } from './lambert';

// 遷移の方式名。候補の一覧に付く札(SPEC/PLAN.md「遷移方式」)。
// - lambert: 出発から到着まで周回を挟まない直接遷移。
// - low-energy: 遷移弧の途中で完全周回を挟む長時間の解。
// - bi-elliptic: 高い中間遠点を経る3インパルス遷移(近円・同面のときだけ出る)。
// - aerobrake: 目標側天体の大気で遠点を削る遷移(大気と弾道係数があるときだけ出る)。
export type TransferMethod = 'lambert' | 'low-energy' | 'bi-elliptic' | 'aerobrake';

// 求解済みの1候補。nodes は計画ノードへそのまま書ける噴射後の絶対状態の列で、
// 先頭が出発インパルス、末尾が到着インパルス。
export interface TransferCandidate {
  readonly method: TransferMethod;
  readonly departAt: number;   // 出発インパルスの時刻 [simTime s]
  readonly arriveAt: number;   // 目標へ到達する時刻 [simTime s]
  readonly deltaV: number;     // インパルス合計 [m/s]
  readonly departDeltaV: number;
  readonly arriveDeltaV: number;
  readonly nodes: readonly KinematicState[];
}

// 会合目標の状態の問い合わせ口。軌道標識・天体・個体のどれでも同じ形に包む。
export interface TransferPlannerTarget {
  // 時刻 t の絶対 ECI 状態。求まらない時刻は null。
  stateAt(t: number): KinematicState | null;
  // 位相配置が繰り返す見通しの周期 [s]。窓の外を探す目安。不明・非周期なら null。
  readonly period: number | null;
}

export interface TransferPlannerConstraints {
  readonly deadline?: number;    // 到着はこの時刻まで [simTime s]
  readonly maxDeltaV?: number;   // インパルス合計の上限 [m/s]
  readonly departures?: number;  // 出発時刻の格子点数
  readonly maxCandidates?: number;
  // 船の弾道係数の逆数 Cd·A/m [m²/kg]。正の値を渡すと大気減速の候補も作る。
  readonly bcInv?: number;
}

const DEFAULT_DEPARTURES = 24;
const DEFAULT_CANDIDATES = 8;
// 出発側の公転周期に対する飛行時間の比の格子。TOF_FRACTIONS は直行、
// LOW_ENERGY_TOF_FRACTIONS は周回を挟める長い飛行時間帯。
const TOF_FRACTIONS: readonly number[] = [0.25, 0.4, 0.55, 0.75, 1.0];
const LOW_ENERGY_TOF_FRACTIONS: readonly number[] = [1.5, 2.5, 4, 6, 9, 14];
const LOW_ENERGY_MAX_REVS = 2;
const MIN_DEPART_LEAD = 30; // 出発までの最小猶予 [s] — 求解中の時間バリアと同じ余裕

// 閉形式レーン(二重楕円・大気減速)が前提にする近円・同面の許容ずれ。
const ANALYTIC_MAX_ECCENTRICITY = 0.02;
const ANALYTIC_MIN_PLANAR_DOT = 0.996; // 両軌道の法線のなす角 ≲ 5°、かつ同じ回転方向
// 二重楕円の中間遠点半径 = 両軌道半径の大きいほう × この比。
const BI_ELLIPTIC_AP_FACTORS: readonly number[] = [2, 6];
// 位相合わせの出発時刻走査の刻み数と、走査幅の上限(出発窓の倍率)。
const PHASE_SAMPLES = 384;
const PHASE_WINDOW_FACTOR_MAX = 8;
// 「大気上端」は抗力が実効ゼロになる密度で定める(動力学側の下限と同じ値)。
const DRAG_DENSITY_FLOOR = 1e-15; // [kg/m³]
// 近点距離の下限は表面(衝突球または基準楕円体の小さいほう)のすぐ上。
const CORRIDOR_FLOOR_FACTOR = 1.001;

const TWO_PI = 2 * Math.PI;
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const visViva = (mu: number, r: number, a: number): number => Math.sqrt(mu * (2 / r - 1 / a));
const halfPeriodOf = (a: number, mu: number): number => Math.PI * Math.sqrt((a * a * a) / mu);

// shipState(絶対 ECI)の船が center の重力圏で target へ会合する遷移候補を返す。
// 出発側が双曲線・放物線上にある、または要素が求まらない場合は空。
export function planTransfers(
  shipState: KinematicState,
  center: CelestialBody,
  target: TransferPlannerTarget,
  constraints: TransferPlannerConstraints = {},
): TransferCandidate[] {
  const mu = center.def.mu;
  const t0 = shipState.t;
  const elements = orbitalElementsOf(shipState, center, t0);
  if (elements === null || !(elements.a > 0)) return [];
  const shipPeriod = keplerPeriod(elements.a, mu);
  const window = target.period ?? shipPeriod;
  const nDepart = Math.max(1, constraints.departures ?? DEFAULT_DEPARTURES);
  const maxKeep = Math.max(1, constraints.maxCandidates ?? DEFAULT_CANDIDATES);
  const departBegin = t0 + MIN_DEPART_LEAD;

  const out: TransferCandidate[] = [];
  const keep = (c: TransferCandidate | null): void => {
    if (c === null) return;
    if (constraints.deadline !== undefined && c.arriveAt > constraints.deadline) return;
    if (constraints.maxDeltaV !== undefined && c.deltaV > constraints.maxDeltaV) return;
    out.push(c);
  };

  // ランベルト格子。直行と長時間(多周回)の2レーンを同じ出発格子で走る。
  const lanes: readonly { tofFractions: readonly number[]; maxRevs: number }[] = [
    { tofFractions: TOF_FRACTIONS, maxRevs: 0 },
    { tofFractions: LOW_ENERGY_TOF_FRACTIONS, maxRevs: LOW_ENERGY_MAX_REVS },
  ];
  for (let i = 0; i < nDepart; i++) {
    const tD = departBegin + (window * i) / nDepart;
    if (constraints.deadline !== undefined && tD > constraints.deadline) continue;
    const depart = stateOnOrbitAt(elements, tD); // 中心相対
    if (depart === null) continue;
    const r1 = depart.r;
    const centerD = center.stateAt(tD);
    for (const lane of lanes) {
      for (const f of lane.tofFractions) {
        const tof = shipPeriod * f;
        const tA = tD + tof;
        if (constraints.deadline !== undefined && tA > constraints.deadline) continue;
        const targetState = target.stateAt(tA);
        if (targetState === null) continue;
        const centerA = center.stateAt(tA);
        const r2 = sub(targetState.r, centerA.r);
        const vT = sub(targetState.v, centerA.v);
        for (const sol of solveLambert(r1, r2, tof, mu, { maxRevs: lane.maxRevs })) {
          const dv1 = len(sub(sol.v1, depart.v));
          const dv2 = len(sub(vT, sol.v2));
          const total = dv1 + dv2;
          if (!(total > 0)) continue;
          keep({
            method: sol.revolutions > 0 ? 'low-energy' : 'lambert',
            departAt: tD,
            arriveAt: tA,
            deltaV: total,
            departDeltaV: dv1,
            arriveDeltaV: dv2,
            nodes: [
              kinematicState(tD, add(r1, centerD.r), add(sol.v1, centerD.v)),
              kinematicState(tA, add(r2, centerA.r), add(vT, centerA.v)),
            ],
          });
        }
      }
    }
  }

  // 閉形式レーン。位相合わせの出発探索は、位相差が一巡する会合周期まで幅を取る。
  const geo = circularCoplanarGeometry(elements, target, center, t0, window);
  if (geo !== null) {
    const synodic = Math.abs(shipPeriod - geo.targetPeriod) > 1e-9
      ? (shipPeriod * geo.targetPeriod) / Math.abs(shipPeriod - geo.targetPeriod)
      : Infinity;
    const searchEnd = departBegin
      + Math.min(Math.max(window, synodic), PHASE_WINDOW_FACTOR_MAX * Math.max(window, shipPeriod));
    for (const factor of BI_ELLIPTIC_AP_FACTORS) {
      const rb = Math.max(geo.rShip, geo.rTarget) * factor;
      keep(biEllipticCandidate(mu, center, target, elements, geo, rb, departBegin, searchEnd));
    }
    if (constraints.bcInv !== undefined && constraints.bcInv > 0) {
      const atm = center.atmosphereAt(t0);
      if (atm !== null) {
        keep(aerobrakeCandidate(mu, center, target, elements, geo, atm, constraints.bcInv, departBegin, searchEnd));
      }
    }
  }

  // Δv 昇順で上位を残し、返す候補は到着時刻順(早い到着ほど先)に並べる。
  out.sort((a, b) => a.deltaV - b.deltaV);
  const kept = out.slice(0, maxKeep);
  kept.sort((a, b) => a.arriveAt - b.arriveAt);
  return kept;
}

// 閉形式レーンで使う幾何情報。両軌道は近円・同面・同回転が前提。
interface CircularCoplanarGeometry {
  readonly targetPeriod: number; // 目標軌道の周期 [s]
  readonly rShip: number;        // 出発軌道の代表半径(近円近似で半長軸を使う) [m]
  readonly rTarget: number;      // 目標軌道の代表半径 [m]
  readonly eX: Vec3;             // 出発軌道面内の慣性固定の基準方向
  readonly eY: Vec3;             // eX に直交する面内方向(順行側)
}

// 閉形式レーンの前提を確かめ、成り立つなら幾何情報を返す。出発・目標のどちらかが
// 近円でない・同面でない・要素が引けないときは null(ランベルト系だけを返す)。
function circularCoplanarGeometry(
  shipElements: OrbitalElements,
  target: TransferPlannerTarget,
  center: CelestialBody,
  t0: number,
  window: number,
): CircularCoplanarGeometry | null {
  if (!(shipElements.e < ANALYTIC_MAX_ECCENTRICITY)) return null;
  // 目標の要素は代表時刻で1回引く。一部の時刻で解けない目標もあるので数点を試す。
  let targetState: KinematicState | null = null;
  for (const frac of [0, 0.5]) {
    targetState = target.stateAt(t0 + frac * window);
    if (targetState !== null) break;
  }
  if (targetState === null) return null;
  const targetElements = orbitalElementsOf(targetState, center, targetState.t);
  if (targetElements === null || !(targetElements.a > 0) || !isFinite(targetElements.period)) {
    return null;
  }
  if (!(targetElements.e < ANALYTIC_MAX_ECCENTRICITY)) return null;
  // 法線の内積で同面・同向きをまとめて判定する(逆行では負になる)。
  if (dot(shipElements.hHat, targetElements.hHat) < ANALYTIC_MIN_PLANAR_DOT) return null;
  return {
    targetPeriod: targetElements.period,
    rShip: shipElements.a,
    rTarget: targetElements.a,
    eX: shipElements.pHat,
    eY: cross(shipElements.hHat, shipElements.pHat),
  };
}

// 出発経度と到着経度が一致する出発時刻の列。遷移弧が出発点の経度へ戻る設計
// (二重楕円・大気減速)では、出発時刻だけが位相合わせの自由度になる。
// 経度差には ±π の折り返しがあるので、連続した値へ伸ばしてから 2π の倍数の
// 横切りを拾う(折り返し点の偽の符号反転を根としないため)。
function phaseMatchedDepartures(
  shipElements: OrbitalElements,
  target: TransferPlannerTarget,
  center: CelestialBody,
  transferTime: number,
  tBegin: number,
  tEnd: number,
  geo: CircularCoplanarGeometry,
): number[] {
  if (!(tEnd > tBegin)) return [];
  // 目標の到着時経度 − 船の出発時経度 [rad] (−π..π)。解けない時刻は null。
  const gapAt = (tD: number): number | null => {
    const dep = stateOnOrbitAt(shipElements, tD);
    const tgt = target.stateAt(tD + transferTime);
    if (dep === null || tgt === null) return null;
    const rel = sub(tgt.r, center.stateAt(tD + transferTime).r);
    return wrapPi(
      Math.atan2(dot(rel, geo.eY), dot(rel, geo.eX))
        - Math.atan2(dot(dep.r, geo.eY), dot(dep.r, geo.eX)),
    );
  };
  const roots: number[] = [];
  let prevT = tBegin;
  let prevGap = gapAt(tBegin);
  let unwrapped = prevGap ?? 0;
  for (let i = 1; i <= PHASE_SAMPLES; i++) {
    const t = tBegin + ((tEnd - tBegin) * i) / PHASE_SAMPLES;
    const g = gapAt(t);
    if (g === null || prevGap === null) {
      prevT = t;
      prevGap = g;
      if (g !== null) unwrapped = g;
      continue;
    }
    const uPrev = unwrapped;
    unwrapped += wrapPi(g - prevGap);
    const lo = Math.min(uPrev, unwrapped);
    const hi = Math.max(uPrev, unwrapped);
    for (let k = Math.ceil(lo / TWO_PI); k * TWO_PI <= hi; k++) {
      const root = bisectPhaseRoot(gapAt, prevT, t);
      if (root !== null) roots.push(root);
    }
    prevT = t;
    prevGap = g;
  }
  return roots;
}

// gapAt の零点を区間 [ta, tb] で二分する。呼び出し側が零点の存在を確認済みの前提。
function bisectPhaseRoot(
  gapAt: (tD: number) => number | null,
  ta: number,
  tb: number,
): number | null {
  const gA = gapAt(ta);
  const gB = gapAt(tb);
  if (gA === null || gB === null) return null;
  if (gA === 0) return ta;
  if (gA * gB > 0) return null;
  let a = ta;
  let b = tb;
  let fA = gA;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    const gM = gapAt(m);
    if (gM === null) return null;
    if (fA * gM <= 0) {
      b = m;
    } else {
      a = m;
      fA = gM;
    }
  }
  return (a + b) / 2;
}

// 円軌道 rShip → 円軌道 rTarget の二重楕円候補。中間遠点半径 rb を固定し、
// 到着経度が出発経度へ一致する最早の出発を拾う(遷移は出発経度へ戻る)。
// ノードは [出発インパルス, 遠点での第2遷移への切り替え, 到着インパルス]。
function biEllipticCandidate(
  mu: number,
  center: CelestialBody,
  target: TransferPlannerTarget,
  shipElements: OrbitalElements,
  geo: CircularCoplanarGeometry,
  rb: number,
  tBegin: number,
  tEnd: number,
): TransferCandidate | null {
  const transferTime =
    halfPeriodOf((geo.rShip + rb) / 2, mu) + halfPeriodOf((geo.rTarget + rb) / 2, mu);
  for (const tD of phaseMatchedDepartures(shipElements, target, center, transferTime, tBegin, tEnd, geo)) {
    const depart = stateOnOrbitAt(shipElements, tD);
    if (depart === null) continue;
    const rD = len(depart.r);
    const eXd = norm(depart.r);
    const eYd = cross(shipElements.hHat, eXd);
    // 実際の出発半径 rD で楕円を組む(近円近似のずれはインパルス側が吸収する)。
    const a1 = (rD + rb) / 2;
    const a2 = (geo.rTarget + rb) / 2;
    const tMid = tD + halfPeriodOf(a1, mu);
    const tA = tMid + halfPeriodOf(a2, mu);
    const arrive = target.stateAt(tA);
    if (arrive === null) continue;
    const v1 = scale(eYd, visViva(mu, rD, a1));
    const dv1 = len(sub(v1, depart.v));
    const dv2 = Math.abs(visViva(mu, rb, a2) - visViva(mu, rb, a1));
    const centerA = center.stateAt(tA);
    const dv3 = len(sub(sub(arrive.v, centerA.v), scale(eYd, visViva(mu, geo.rTarget, a2))));
    const total = dv1 + dv2 + dv3;
    if (!(total > 0)) continue;
    const centerD = center.stateAt(tD);
    const centerM = center.stateAt(tMid);
    return {
      method: 'bi-elliptic',
      departAt: tD,
      arriveAt: tA,
      deltaV: total,
      departDeltaV: dv1,
      arriveDeltaV: dv3,
      nodes: [
        kinematicState(tD, add(depart.r, centerD.r), add(v1, centerD.v)),
        kinematicState(
          tMid,
          add(scale(eXd, -rb), centerM.r),
          add(scale(eYd, -visViva(mu, rb, a2)), centerM.v),
        ),
        kinematicState(tA, arrive.r, arrive.v),
      ],
    };
  }
  return null;
}

interface AerobrakePlan {
  readonly rPeri1: number;  // 1回目の通過の近点距離 [m]
  readonly rApoMid: number; // 1回目の通過後の遠点距離 [m]
  readonly rPeri2: number;  // 2回目の通過の近点距離 [m]
}

// 抗力が実効ゼロになる高度。地表でさえ下限を割る大気なら null。
function atmosphereTopAltitude(atm: Atmosphere): number | null {
  if (!(atmosphericDensity(0, atm) > DRAG_DENSITY_FLOOR)) return null;
  let hi = 1e6;
  while (atmosphericDensity(hi, atm) > DRAG_DENSITY_FLOOR) {
    hi *= 4;
    if (!(hi < 1e10)) return null;
  }
  let lo = 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (atmosphericDensity(mid, atm) > DRAG_DENSITY_FLOOR) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// 遠点距離 rApoIn・近点距離 rPeri の軌道が近点を1回通過したあとの遠点距離。
// 抗力が削る速さは、指数大気と「通過中は近点速さでほぼ一定」の近似で
//   ΔV ≈ ½·bcInv·v_p·ρ_p·√(2π·r_p·H·(1+e)/e)
// と見積る(近点からの高度が角度の2乗で増えることに由来するガウス積分)。
// 通過後も正のエネルギー(捕獲されない)なら Infinity。
function apoapsisAfterPass(
  rApoIn: number,
  rPeri: number,
  mu: number,
  bcInv: number,
  atm: Atmosphere,
): number {
  const aIn = (rApoIn + rPeri) / 2;
  const e = (rApoIn - rPeri) / (rApoIn + rPeri);
  if (!(e > 1e-9)) return rPeri; // ほぼ円軌道の「通過」は減衰して近点高度へ沈む
  const vPeri = visViva(mu, rPeri, aIn);
  const rho = atmosphericDensity(rPeri - atm.equatorRadius, atm);
  const scaleH = atmosphericScaleHeight(rPeri - atm.equatorRadius, atm);
  const pathDensity = rho * Math.sqrt((2 * Math.PI * rPeri * scaleH * (1 + e)) / e);
  // 見積は近点速さを反転させない(抗力は減速だけをする)。
  const dv = Math.min(0.5 * bcInv * vPeri * pathDensity, vPeri * 0.999);
  const vOut = vPeri - dv;
  const energy = 0.5 * vOut * vOut - mu / rPeri;
  if (!(energy < 0)) return Infinity;
  return -mu / energy - rPeri; // 新しい遠点距離 = 2a' − r_p
}

// 通過後の遠点距離を targetApo にする近点距離を (lo, hi) で二分する。
// apoapsisAfterPass は rPeri の単調増加関数(浅いほど削れない)なので、
// 端が目標を挟まない(削り足りない/削りすぎる)ときは null。
function periapsisForApoapsis(
  rApoIn: number,
  targetApo: number,
  lo: number,
  hi: number,
  mu: number,
  bcInv: number,
  atm: Atmosphere,
): number | null {
  const g = (rp: number): number => apoapsisAfterPass(rApoIn, rp, mu, bcInv, atm) - targetApo;
  if (!(g(lo) <= 0) || !(g(hi) >= 0)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) <= 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// 大気減速の廊下設計。遠点 rShip から近点を大気内へ潜らせ、1回目の通過で遠点を
// 削り、中間の遠点でのトリム噴射で2回目の近点を調整し、2回目の通過で遠点を
// 目標半径へ正確に着ける。廊下が組めない(削りが足りない・浅すぎても割り込む)ときは null。
function aerobrakePlan(
  rShip: number,
  rTarget: number,
  mu: number,
  bcInv: number,
  atm: Atmosphere,
  surfaceRadius: number,
): AerobrakePlan | null {
  if (!(rShip > rTarget)) return null; // 遠点を下げる遷移だけを扱う
  const top = atmosphereTopAltitude(atm);
  if (top === null) return null;
  const rTop = atm.equatorRadius + top;
  const rFloor = Math.max(surfaceRadius, Math.min(atm.equatorRadius, atm.polarRadius)) * CORRIDOR_FLOOR_FACTOR;
  // 2回の通過で削る量は、遠点距離の中点を1回目の目標にして分ける。
  const rMid = (rShip + rTarget) / 2;
  const hi1 = Math.min(rTop, rMid);
  if (!(rFloor < hi1)) return null;
  const solved1 = periapsisForApoapsis(rShip, rMid, rFloor, hi1, mu, bcInv, atm);
  // 中点へ着けられないときは廊下の端(最深 or 最浅)で1回目を組む。
  const rPeri1 = solved1 ?? (apoapsisAfterPass(rShip, rFloor, mu, bcInv, atm) > rMid ? rFloor : hi1);
  const rApoMid = apoapsisAfterPass(rShip, rPeri1, mu, bcInv, atm);
  if (!(rApoMid > rTarget)) return null; // 1回目で目標を割り込むと、次の通過では戻せない
  const hi2 = Math.min(rTop, rTarget);
  if (!(rFloor < hi2)) return null;
  const rPeri2 = periapsisForApoapsis(rApoMid, rTarget, rFloor, hi2, mu, bcInv, atm);
  if (rPeri2 === null) return null; // 2回目は遠点 = 目標半径に正確に着ける必要がある
  return { rPeri1, rApoMid, rPeri2 };
}

// 大気減速候補。ノードは [出発インパルス, 中間遠点での近点トリム, 遠点での円化] の
// 3インパルスで、抗力による2回の近点通過はノードにしない(噴射ではない)。
// 位相合わせは出発経度への回帰を使う(二重楕円と同じ)。
function aerobrakeCandidate(
  mu: number,
  center: CelestialBody,
  target: TransferPlannerTarget,
  shipElements: OrbitalElements,
  geo: CircularCoplanarGeometry,
  atm: Atmosphere,
  bcInv: number,
  tBegin: number,
  tEnd: number,
): TransferCandidate | null {
  const plan = aerobrakePlan(geo.rShip, geo.rTarget, mu, bcInv, atm, center.def.radius);
  if (plan === null) return null;
  const { rPeri1, rApoMid, rPeri2 } = plan;
  const transferTime =
    halfPeriodOf((geo.rShip + rPeri1) / 2, mu) + halfPeriodOf((rApoMid + rPeri1) / 2, mu)
    + halfPeriodOf((rApoMid + rPeri2) / 2, mu) + halfPeriodOf((geo.rTarget + rPeri2) / 2, mu);
  for (const tD of phaseMatchedDepartures(shipElements, target, center, transferTime, tBegin, tEnd, geo)) {
    const depart = stateOnOrbitAt(shipElements, tD);
    if (depart === null) continue;
    const rD = len(depart.r);
    const eXd = norm(depart.r);
    const eYd = cross(shipElements.hHat, eXd);
    const a0 = (rD + rPeri1) / 2;
    const a1 = (rApoMid + rPeri1) / 2;
    const a2 = (rApoMid + rPeri2) / 2;
    const a3 = (geo.rTarget + rPeri2) / 2;
    const tMid = tD + halfPeriodOf(a0, mu) + halfPeriodOf(a1, mu);
    const tA = tMid + halfPeriodOf(a2, mu) + halfPeriodOf(a3, mu);
    const arrive = target.stateAt(tA);
    if (arrive === null) continue;
    const v1 = scale(eYd, visViva(mu, rD, a0));
    const dv1 = len(sub(v1, depart.v));
    const dv2 = Math.abs(visViva(mu, rApoMid, a2) - visViva(mu, rApoMid, a1));
    const centerA = center.stateAt(tA);
    const dv3 = len(sub(sub(arrive.v, centerA.v), scale(eYd, visViva(mu, geo.rTarget, a3))));
    const total = dv1 + dv2 + dv3;
    if (!(total > 0)) continue;
    const centerD = center.stateAt(tD);
    const centerM = center.stateAt(tMid);
    return {
      method: 'aerobrake',
      departAt: tD,
      arriveAt: tA,
      deltaV: total,
      departDeltaV: dv1,
      arriveDeltaV: dv3,
      nodes: [
        kinematicState(tD, add(depart.r, centerD.r), add(v1, centerD.v)),
        kinematicState(
          tMid,
          add(scale(eXd, rApoMid), centerM.r),
          add(scale(eYd, visViva(mu, rApoMid, a2)), centerM.v),
        ),
        kinematicState(tA, arrive.r, arrive.v),
      ],
    };
  }
  return null;
}
