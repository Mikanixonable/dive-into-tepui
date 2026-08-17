// PlanArc と PredictedArc が共有する、1本の DynamicTrajectory を [state0.t, end] の範囲に
// 限って答える処理。答え方をここへ集約することで、区間の切り方が両者で食い違わないようにする。
import { KinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';

// 積分の終端は要求時刻に対して丸め誤差ぶん手前に落ちうる。この幅までは終端そのものとみなす。
export const EPOCH_EPS = 1e-6;

// 時刻 t が答える範囲の終端 end 以内(丸め誤差込み)か。積分中に見つけた到達点・極値を
// 答える前に、それが今の範囲に残っているかを判定するために使う。
export function withinEnd(t: number, end: number): boolean {
  return t <= end + EPOCH_EPS;
}

// 時刻 t の状態を、答える範囲を end で切ったうえで trajectory から引く。end を超える、
// または保持区間の外なら null。先端を丸め誤差ぶん超えるだけの t は先端そのものとして答える。
export function stateAt(trajectory: DynamicTrajectory, t: number, end: number): KinematicState | null {
  if (!withinEnd(t, end)) return null;
  const tip = trajectory.state;
  if (t > tip.t) return t - tip.t <= EPOCH_EPS ? tip : null;
  return trajectory.at(t);
}

// 時刻昇順のサンプル列を end で切る。末尾から end を超える間だけ削り、削る必要が無ければ
// source をそのまま返す。
export function clipSamplesTo(
  source: readonly KinematicState[], end: number,
): readonly KinematicState[] {
  if (source.length === 0 || source[source.length - 1]!.t <= end) return source;
  let cut = source.length;
  while (cut > 0 && source[cut - 1]!.t > end) cut--;
  return source.slice(0, cut);
}
