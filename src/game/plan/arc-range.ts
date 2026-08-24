// 1本の DynamicTrajectory を、答える範囲の終端 end で切って読む処理。end を越える時刻と
// サンプルを落とし、丸め誤差ぶんだけ先端を越えるだけの時刻は先端そのものとして答える。
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

// 時刻範囲の両端を状態列上で補間し、範囲内の元サンプルと合わせて返す。表示線と、その線を
// 走査する交点探索が同じ境界を読むための共有処理。at は元の弧が答えられる範囲だけを返し、
// 範囲外では null を返す。
export function samplesInRange(
  source: readonly KinematicState[], from: number, to: number,
  at: (t: number) => KinematicState | null,
): readonly KinematicState[] {
  if (source.length === 0 || to < from) return [];
  const start = Math.max(from, source[0]!.t);
  const end = Math.min(to, source[source.length - 1]!.t);
  if (end < start) return [];

  const result: KinematicState[] = [];
  const append = (state: KinematicState | null): void => {
    if (!state) return;
    const last = result[result.length - 1];
    if (last && Math.abs(last.t - state.t) <= EPOCH_EPS) return;
    result.push(state);
  };
  append(at(start));
  for (const state of source) {
    if (state.t > start + EPOCH_EPS && state.t < end - EPOCH_EPS) append(state);
  }
  append(at(end));
  return result;
}
