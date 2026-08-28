// 曲が一巡して同じ音列へ戻るまでの長さ。試聴のシークバーの可動域や、作曲用プレビュー
// (tools/bgm-lab)の一巡表示が、これを基準に位置を扱う。
import { BgmTrack } from './tracks/types';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

// この曲が一巡するまでのステップ数。phasing は各循環(移調・音域・両声部・パッド・
// ドローン・煌めき)がそれぞれ独立に step の剰余を見るだけなので、一巡は周期の最小公倍数に
// なる。suite は区間を通し終えたら先頭へ戻る構造なので、全区間の長さの合計がそのまま一巡。
// 一巡という概念を持たない kind は 0 を返す。
export function trackCycleSteps(track: BgmTrack): number {
  if (track.kind === 'phasing') {
    const p = track.params;
    const periods = [
      p.transpose.values.length * p.transpose.everySteps,
      p.octave.values.length * p.octave.everySteps,
      p.voiceA.pattern.length,
      p.voiceB.pattern.length,
      p.pads.chords.length * p.pads.everySteps,
      p.drone.everySteps,
      ...(p.sparkle ? [p.sparkle.everySteps] : []),
    ].filter((n) => n > 0);
    return periods.reduce(lcm, 1);
  }
  if (track.kind === 'suite') {
    return track.params.sections.reduce((sum, section) => sum + section.lengthSteps, 0);
  }
  return 0;
}

// 一巡ぶんの長さを秒数で。suite は区間ごとに stepDur が違うので、区間の長さ×stepDur を積む。
export function trackCycleDurationSec(track: BgmTrack): number {
  if (track.kind === 'phasing') return trackCycleSteps(track) * track.params.stepDur;
  if (track.kind === 'suite') {
    return track.params.sections.reduce((sum, section) => sum + section.lengthSteps * section.params.stepDur, 0);
  }
  return 0;
}

// 一巡の中の経過秒数から、対応するステップ番号を出す。シーク先の指定に使う。suite は
// 区間ごとに stepDur が違うので、先頭の区間から順に経過秒数を引き、timeSec が収まる区間の
// 中で改めてステップへ換算する。
export function stepAtTime(track: BgmTrack, timeSec: number): number {
  if (track.kind === 'phasing') return Math.floor(timeSec / track.params.stepDur);
  if (track.kind === 'suite') {
    let remaining = timeSec;
    let stepBase = 0;
    for (const section of track.params.sections) {
      const sectionDurSec = section.lengthSteps * section.params.stepDur;
      if (remaining < sectionDurSec) return stepBase + Math.floor(remaining / section.params.stepDur);
      remaining -= sectionDurSec;
      stepBase += section.lengthSteps;
    }
    return stepBase;
  }
  return 0;
}
