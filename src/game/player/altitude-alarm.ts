// 自機の高度低下の監視と警告。離心率による短周期の高度振動で誤反応しないよう、高度も変化率も
// 指数移動平均で平滑化する。
import type { CelestialBody } from '../../physics/celestial-body';
import { ellipsoidAltitude } from '../../physics/atmosphere';
import { type Vec3, sub } from '../../math/vec3';

const ALT_EMA_TIME_CONST = 3; // 高度・降下率EMAの時定数 [s]
const ALT_DESCEND_WARN_RATE = -3; // この降下率(EMA)を下回ると警告 [m/s]
const ALT_DESCEND_CLEAR_RATE = -1; // この降下率(EMA)まで戻ると警告解除 [m/s]

export interface SerializedAltitudeAlarm {
  readonly descendWarned: boolean;
  // 高度の指数移動平均 [m]。まだ高度を測っていなければ null。
  readonly altEma: number | null;
  readonly altRateEma: number;
  // 高度の警告済みしきい値 [m]。記録の後方互換のためだけに残す。
  readonly warnedThresholds?: readonly number[];
}

export class AltitudeAlarm {
  // descendWarned は降下中とみなされているか、altEma は高度の指数移動平均 [m](まだ測って
  // いなければ null)、altRateEma は高度変化率の指数移動平均 [m/s]。
  public constructor(
    private _descendWarned = false,
    private altEma: number | null = null,
    private altRateEma = 0,
  ) { }

  // 直列化した平滑化と警告の状態から復元する。
  public static deserialize(serialized: SerializedAltitudeAlarm): AltitudeAlarm {
    return new AltitudeAlarm(serialized.descendWarned, serialized.altEma, serialized.altRateEma);
  }

  // 降下中とみなされているか。
  public get descendWarned(): boolean { return this._descendWarned; }

  // 平滑化した高度 [m]。まだ測っていなければ null。
  public get smoothedAltitudeM(): number | null { return this.altEma; }

  // 平滑化した高度変化率 [m/s]。下降が負。
  public get smoothedAltitudeRateMps(): number { return this.altRateEma; }

  // 平滑化と警告の状態をシリアライズ形式へ変換する。
  public serialize(): SerializedAltitudeAlarm {
    return {
      descendWarned: this._descendWarned,
      altEma: this.altEma,
      altRateEma: this.altRateEma,
    };
  }

  // 位置 r の高度を atmosphereBody の基準楕円体から測り、平滑化して警告を出す。大気天体が
  // いなければ「大気の底」が無いので何もしない。
  public update(
    dt: number, r: Vec3, atmosphereBody: CelestialBody | null, atmospherePivot: number,
  ): void {
    if (atmosphereBody === null) return;
    const atm = atmosphereBody.atmosphereAt(atmospherePivot);
    if (atm === null) return;
    this.step(dt, ellipsoidAltitude(sub(r, atmosphereBody.positionAt(atmospherePivot)), atm));
  }

  // 平滑化を1歩進め、降下率の警告を見る。
  private step(dt: number, alt: number): void {
    // 高度と変化率を平滑化する。最初の1歩は測った高度から始める
    const prevEma = this.altEma ?? alt;
    const k = Math.min(1, dt / ALT_EMA_TIME_CONST);
    this.altEma = prevEma + (alt - prevEma) * k;
    if (dt > 1e-6) {
      const rate = (this.altEma - prevEma) / dt;
      this.altRateEma += (rate - this.altRateEma) * k;
    }
    // 降下の判定はヒステリシスを持つ
    if (this.altRateEma < ALT_DESCEND_WARN_RATE) this._descendWarned = true;
    else if (this.altRateEma > ALT_DESCEND_CLEAR_RATE) this._descendWarned = false;
  }
}
