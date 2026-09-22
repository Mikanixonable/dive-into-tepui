// 自機の高度低下の監視と警告。離心率による短周期の高度振動で誤反応しないよう、高度も変化率も
// 指数移動平均で平滑化する。
import type { CelestialBody } from '../../physics/celestial-body';
import { ellipsoidAltitude } from '../../physics/atmosphere';
import { type Vec3, sub } from '../../math/vec3';
import type { RunEventSink } from '../run-events';

// 高度低下警告のしきい値(降順)。EMA 高度がこれを下回るたびに一度だけ警告する [m]
const ALT_WARN_THRESHOLDS = [120e3, 100e3, 80e3];

const ALT_EMA_TIME_CONST = 3; // 高度・降下率EMAの時定数 [s]
const ALT_DESCEND_WARN_RATE = -3; // この降下率(EMA)を下回ると警告 [m/s]
const ALT_DESCEND_CLEAR_RATE = -1; // この降下率(EMA)まで戻ると警告解除 [m/s]
const ALT_WARN_HYSTERESIS = 5e3; // しきい値の再警告までのヒステリシス幅 [m]

export interface SerializedAltitudeAlarm {
  readonly descendWarned: boolean;
  // 高度の指数移動平均 [m]。まだ高度を測っていなければ null。
  readonly altEma: number | null;
  readonly altRateEma: number;
  readonly warnedThresholds: number[];
}

export class AltitudeAlarm {
  // 警告済みのしきい値 [m]。登り返すと外れ、再び潜れば同じしきい値で再警告する。
  private readonly warnedThresholds: Set<number>;

  // 警告は events へ記録する。descendWarned は降下中とみなされているか、altEma は高度の指数移動
  // 平均 [m](まだ測っていなければ null)、altRateEma は高度変化率の指数移動平均 [m/s]、
  // warnedThresholds は警告済みのしきい値 [m]。
  public constructor(
    private readonly events: RunEventSink,
    private _descendWarned = false,
    private altEma: number | null = null,
    private altRateEma = 0,
    warnedThresholds: readonly number[] = [],
  ) {
    this.warnedThresholds = new Set(warnedThresholds);
  }

  // 直列化した平滑化と警告の状態から復元する。警告は events へ記録する。
  public static deserialize(serialized: SerializedAltitudeAlarm, events: RunEventSink): AltitudeAlarm {
    return new AltitudeAlarm(
      events,
      serialized.descendWarned,
      serialized.altEma,
      serialized.altRateEma,
      serialized.warnedThresholds,
    );
  }

  // 降下中とみなされているか。
  public get descendWarned(): boolean { return this._descendWarned; }

  // 平滑化と警告の状態をシリアライズ形式へ変換する。
  public serialize(): SerializedAltitudeAlarm {
    return {
      descendWarned: this._descendWarned,
      altEma: this.altEma,
      altRateEma: this.altRateEma,
      warnedThresholds: [...this.warnedThresholds],
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

  // 平滑化を1歩進め、降下率としきい値の走破を見る。
  private step(dt: number, alt: number): void {
    // 高度と変化率を平滑化する。最初の1歩は測った高度から始める
    const prevEma = this.altEma ?? alt;
    const k = Math.min(1, dt / ALT_EMA_TIME_CONST);
    const altEma = prevEma + (alt - prevEma) * k;
    this.altEma = altEma;
    if (dt > 1e-6) {
      const rate = (altEma - prevEma) / dt;
      this.altRateEma += (rate - this.altRateEma) * k;
    }
    // 降下の判定はヒステリシスを持つ
    if (this.altRateEma < ALT_DESCEND_WARN_RATE) this._descendWarned = true;
    else if (this.altRateEma > ALT_DESCEND_CLEAR_RATE) this._descendWarned = false;

    // しきい値を下回るたびに1度だけ警告する
    for (const threshold of ALT_WARN_THRESHOLDS) {
      if (altEma < threshold) {
        if (this.warnedThresholds.has(threshold)) continue;
        this.warnedThresholds.add(threshold);
        this.events.record({ kind: 'altitudeWarned', threshold });
      } else if (altEma > threshold + ALT_WARN_HYSTERESIS) {
        this.warnedThresholds.delete(threshold);
      }
    }
  }
}
