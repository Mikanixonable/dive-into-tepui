// インパルス遷移の初値。同一中心天体まわりの円〜楕円軌道について、ホーマン・二重楕円・
// 位相調整・ランデブーの位相角/待ち時間を閉形式で出す純関数群。出る値は二体問題の理想解
// であり、実行側の求解は全力モデルで残差を修正する(PLAN.md「遷移方式」)。
// THREE/DOM 非依存。
import { keplerPeriod, meanMotionFromSemiMajor, semiMajorFromPeriod } from './elements';

export interface TransferImpulses {
  readonly deltaV1: number; // 出発軌道から遷移軌道へ [m/s]
  readonly deltaV2: number; // 遷移軌道から目標軌道へ [m/s]
  readonly transferTime: number; // 遷移弧の飛行時間 [s]
  readonly transferA: number; // 遷移軌道の半長軸 [m]
}

const circV = (r: number, mu: number) => Math.sqrt(mu / r);

// 円軌道 r1 → 円軌道 r2 のホーマン遷移(同面・順行のみ)。楕円軌道や傾斜変更は
// ランベルト/射撃法側が担う — ここは「方式名つきの候補」の比較基準。
export function hohmann(r1: number, r2: number, mu: number): TransferImpulses {
  const aT = (r1 + r2) / 2;
  const v1 = circV(r1, mu);
  const v2 = circV(r2, mu);
  const vT1 = Math.sqrt(mu * (2 / r1 - 1 / aT));
  const vT2 = Math.sqrt(mu * (2 / r2 - 1 / aT));
  return {
    deltaV1: Math.abs(vT1 - v1),
    deltaV2: Math.abs(v2 - vT2),
    transferTime: Math.PI * Math.sqrt((aT * aT * aT) / mu),
    transferA: aT,
  };
}

// 円軌道 r1 → 円軌道 r2 の二重楕円遷移。中間遠点半径 rb (> r1, r2) を指定する。
// 推力は3回: r1→第1遷移楕円、rb で第2遷移楕円へ、r2 で目標円へ。
export function biElliptic(r1: number, r2: number, rb: number, mu: number): {
  deltaV1: number; deltaV2: number; deltaV3: number; transferTime: number;
} {
  const aT1 = (r1 + rb) / 2;
  const aT2 = (r2 + rb) / 2;
  const v1 = circV(r1, mu);
  const v2 = circV(r2, mu);
  const vT1a = Math.sqrt(mu * (2 / r1 - 1 / aT1)); // 第1遷移の近点速度
  const vT1b = Math.sqrt(mu * (2 / rb - 1 / aT1)); // 第1遷移の遠点速度
  const vT2b = Math.sqrt(mu * (2 / rb - 1 / aT2)); // 第2遷移の遠点速度
  const vT2a = Math.sqrt(mu * (2 / r2 - 1 / aT2)); // 第2遷移の近点速度
  return {
    deltaV1: Math.abs(vT1a - v1),
    deltaV2: Math.abs(vT2b - vT1b),
    deltaV3: Math.abs(v2 - vT2a),
    transferTime: Math.PI * (Math.sqrt((aT1 * aT1 * aT1) / mu) + Math.sqrt((aT2 * aT2 * aT2) / mu)),
  };
}

// 位相調整(フェイジング): 同じ近点高を保ったまま位相だけをずらす。
// deltaPhase [rad] は位相を前へ進める量(負なら遅らせる)で、待ち周回数 rev ≥ 1 の
// フェイジング軌道で稼ぐ。フェイジング軌道の周期は T_ph = T·(1 − Δφ/(2π·rev)):
// 位相を進めるなら T_ph < T(速く回って追い越す)、遅らせるなら T_ph > T。
// 戻り値は近点での往復2バーンの Δv と所要時間(= rev · T_ph)。
export function phasing(
  a: number, e: number, deltaPhase: number, revolutions: number, mu: number,
): TransferImpulses & { phasingA: number; phasingPeriod: number } | null {
  const T = keplerPeriod(a, mu);
  const rev = Math.max(1, Math.round(revolutions));
  const Tph = T * (1 - deltaPhase / (2 * Math.PI * rev));
  if (!(Tph > 0)) return null; // 短すぎる位相進めは不可能
  const aPh = semiMajorFromPeriod(Tph, mu);
  const rp = a * (1 - e); // 近点を維持して半長軸だけ変える
  if (!(aPh > rp / 2)) return null; // フェイジング軌道が近点より内側へ潜る
  const vP0 = Math.sqrt(mu * (2 / rp - 1 / a));
  const vPh = Math.sqrt(mu * (2 / rp - 1 / aPh));
  return {
    deltaV1: Math.abs(vPh - vP0),
    deltaV2: Math.abs(vPh - vP0), // 近点へ戻る逆噴射
    transferTime: Tph * rev,
    transferA: aPh,
    phasingA: aPh,
    phasingPeriod: Tph,
  };
}

// ランデブーの位相幾何。追う側(チェイサー)の平均運動 n_c と目標 n_t [rad/s]。
export interface RendezvousPhasing {
  readonly idealLeadAngle: number; // 出発時の目標のリード角 [rad]
  readonly leadAngleError: number; // 現在の位相配置と理想のずれ [rad] (−π〜π)
  readonly waitTime: number; // 次に同じ位相配置が来るまでの時間 [s]
  readonly windowPeriod: number; // 位相配置が繰り返す周期 [s]
}

// ホーマン遷移の飛行時間 tH に対し、目標がちょうど到着点へ進むための出発時リード角
// α_ideal = π − n_t·tH(チェイサーが進行側から目標へ向かう場合)。
export function rendezvousPhasing(
  nChaser: number, nTarget: number, transferTime: number, currentLeadAngle: number,
): RendezvousPhasing {
  const ideal = Math.PI - nTarget * transferTime;
  let err = currentLeadAngle - ideal;
  err = Math.atan2(Math.sin(err), Math.cos(err));
  const relN = nChaser - nTarget;
  const period = Math.abs(relN) > 1e-12 ? (2 * Math.PI) / Math.abs(relN) : Infinity;
  // リード角の誤差が 0 へ戻るまでの時間。誤差が縮む向きに進むのは
  // チェイサーが速い(err>0 で待つ)・遅い(err<0 で待つ)のどちらでも式は同じ。
  const wait = Math.abs(relN) > 1e-12 ? (err / relN) : 0;
  return {
    idealLeadAngle: ideal,
    leadAngleError: err,
    waitTime: ((wait % period) + period) % period,
    windowPeriod: period,
  };
}

export { keplerPeriod, meanMotionFromSemiMajor };
