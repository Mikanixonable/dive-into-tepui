// 気圧へ書き込む高気圧の丘。低気圧の谷(Trough)と同じ形の気圧の起伏を正の深さで持ち、
// 波の尾根の下流側へ座る(配置は anticyclone-tracks.ts)。丘のまわりでは気圧の勾配が
// 外向きなので、低気圧側と同じ釣り合いの式から高気圧性の風と沈降する気流がそのまま
// 出る — 沈降は湿度の式で乾燥として効き、丘の下に大規模な晴れ間を作る。
// 眼と金床は持たない。眼の濃さは谷の芯の曲がりから出るが、浅く広い丘では眼の開く門へ
// 届かず、こちらは気圧へしか書き込まない(eyeAt・anvilAt を持たない)。
import { float } from 'three/tsl';
import { HIGH_COUNT, highPlacementAt } from './anticyclone-tracks';
import { Trough } from './cyclones';
import type { FloatNode, Vec3Node } from '../tsl-types';

export class Highs {
  private readonly ridges: readonly Trough[];

  // 丘を組み、時刻 0 の配置で始める。surfaceRadius は丘を置く天体の半径 [m]、
  // rotationPeriod はその自転周期 [s]。
  public constructor(private readonly surfaceRadius: number, rotationPeriod: number) {
    this.ridges = Array.from(
      { length: HIGH_COUNT }, () => new Trough(surfaceRadius, rotationPeriod),
    );
    this.syncTime(0);
  }

  // 時刻 [s] における配置を uniform へ反映する。
  public syncTime(seconds: number): void {
    for (const [i, ridge] of this.ridges.entries()) {
      ridge.place(highPlacementAt(i, seconds, this.surfaceRadius));
    }
  }

  // 単位方向 direction での気圧の盛り上がりの合計 [hPa](0 以上)。Trough.pressureAt は
  // 深さを負で返すので、正の深さを置いて符号を戻す。
  public pressureAt(direction: Vec3Node): FloatNode {
    return this.ridges.reduce<FloatNode>(
      (sum, ridge) => sum.add(ridge.pressureAt(direction).negate()), float(0),
    );
  }
}
