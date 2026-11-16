// 気圧へ書き込む低気圧の谷の束。熱帯低気圧 TROPICAL_COUNT 個と中緯度の低気圧 LOW_COUNT 個の
// 配置(緯度・経度・深さ・短軸の半径・長軸/短軸の比)を時刻ごとに受けて谷へ写し、単位方向での
// 気圧の落ち込み・眼・金床・閉塞の構造を合算して答える。
import { float, max } from 'three/tsl';
import { LOW_COUNT, lowPlacementsAt } from './low-tracks';
import { TROPICAL_COUNT, tropicalPlacementAt } from './tropical-tracks';
import { PressureFeature } from './pressure-feature';
import type { FloatNode, Vec3Node } from '../tsl-types';

export class Cyclones {
  private readonly tropicals: readonly PressureFeature[];
  private readonly lows: readonly PressureFeature[];
  // 気圧降下および台風の眼の強度は種別を問わず累積する。熱帯低気圧・中緯度低気圧ともに同一の計算規則を適用する。
  private readonly troughs: readonly PressureFeature[];

  // 谷を組み、時刻 0 の配置で始める。surfaceRadius は谷を置く天体の半径 [m]、rotationPeriod は
  // その自転周期 [s]。
  public constructor(private readonly surfaceRadius: number, rotationPeriod: number) {
    this.tropicals = Array.from(
      { length: TROPICAL_COUNT }, () => new PressureFeature(surfaceRadius, rotationPeriod));
    this.lows = Array.from({ length: LOW_COUNT }, () => new PressureFeature(surfaceRadius, rotationPeriod));
    this.troughs = [...this.tropicals, ...this.lows];
    this.syncTime(0);
  }

  // 時刻 [s] における配置を uniform へ反映する。
  public syncTime(seconds: number): void {
    for (const [i, tropical] of this.tropicals.entries()) {
      tropical.place(tropicalPlacementAt(i, seconds));
    }
    const lows = lowPlacementsAt(seconds, this.surfaceRadius);
    for (const [i, low] of this.lows.entries()) {
      low.place(lows[i]!);
    }
  }

  // 単位方向 direction での気圧の落ち込みの合計 [hPa](0 以下)。
  public pressureAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.pressureAt(direction)), float(0));
  }

  // 単位方向 direction での眼の濃さの合計 0..1。
  public eyeAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.eyeAt(direction)), float(0));
  }

  // 単位方向 direction での金床の濃さの合計 0..1。
  public anvilAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.anvilAt(direction)), float(0));
  }

  // 単位方向 direction での乾いた舌の濃さ 0..1。閉塞は中緯度の低気圧だけが持つ — 重なった所で
  // 二重に乾かないよう、合計ではなく最も強いものを取る。
  public dryTongueAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((acc, trough) => max(acc, trough.dryTongueAt(direction)), float(0));
  }

  // 単位方向 direction でのコンマの頭の濃さ 0..1。
  public commaHeadAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((acc, trough) => max(acc, trough.commaHeadAt(direction)), float(0));
  }

  // 単位方向 direction での閉塞した芯の濃さ 0..1。
  public occludedCoreAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((acc, trough) => max(acc, trough.occludedCoreAt(direction)), float(0));
  }
}
