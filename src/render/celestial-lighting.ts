// 地球・月を含む天体描画が共有する、表示時刻に固定された照明入力。
// 表示メッシュは戦闘ビューで距離圧縮されるため、光源方向を描画座標から求めてはならない。
// このコンテキストが真の天体暦と表示時刻を一箇所で保持し、以後の大気・食・地球照もここへ
// 追加する。
import { Ephemeris } from '../physics/ephemeris';
import { AttractorId } from '../physics/attractor';
import { Vec3 } from '../physics/vec3';

export class CelestialLightingContext {
  private time = 0;

  constructor(private readonly ephemeris: Ephemeris) {}

  get displayTime(): number { return this.time; }

  sync(displayTime: number): void {
    this.time = displayTime;
  }

  // position は常に真の ECI 位置 [m]。返す方向も ECI の単位ベクトルである。
  sunDirectionFrom(position: Vec3): Vec3 {
    return this.ephemeris.sunDirFrom(position, this.time);
  }

  /** 食・惑星照の計算用。表示圧縮前の真のECI位置を返す。 */
  positionOf(id: AttractorId): Vec3 {
    return this.ephemeris.positionOf(id, this.time);
  }
}
