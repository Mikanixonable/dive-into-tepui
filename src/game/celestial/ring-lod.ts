// 環の帯を面(annulus)として描くか、線(line)として描くかの判定。幅が半径の 1/10,000
// 程度になる細環は annulus のまま描くとズームアウトで消えてしまうので、その位置での
// 実距離の幅が画面上で1ピクセルを割ったら線へ切り替える。距離そのものは呼び出し側が
// 都度 metersPerPixel を渡す(このモジュールはカメラを知らない)。1px という値そのものが
// 見やすさのための調整値(厳密な幾何ではない)なので、`physics/` ではなくここに置く
// (`.claude/skills/refactor-fixed/SKILL.md` §4 — `projection.ts`/`occlusion.ts` は調整値を
// 含まない厳密な幾何だから physics/ に属するが、この 1px 閾値はそうではない)。
export type RingVisualForm = 'annulus' | 'line';

const RING_LINE_THRESHOLD_PX = 1;

export function ringVisualForm(bandWidthMeters: number, metersPerPixelAtBand: number): RingVisualForm {
  return bandWidthMeters / metersPerPixelAtBand < RING_LINE_THRESHOLD_PX ? 'line' : 'annulus';
}
