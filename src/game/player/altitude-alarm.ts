// 自機の高度低下の監視と警告。離心率による短周期の高度振動で誤反応しないよう、高度も変化率も
// 指数移動平均で平滑化する。**熱ではない** — 温度も動圧も見ない。
import type { CelestialBody } from '../../physics/celestial-body';
import { ellipsoidAltitude } from '../../physics/atmosphere';
import { Vec3, sub } from '../../math/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';

export class AltitudeAlarm {
  // 降下中とみなされているか。HUD の高度表示が読む。
  descendWarned = false;

  private altEma = NaN; // 高度の指数移動平均
  private altRateEma = 0; // 高度変化率の指数移動平均 [m/s]
  // 既に警告済みのしきい値。しきい値 + ヒステリシスまで登り返すと解除され、再度潜った際に
  // 同じしきい値で再警告できる。
  private readonly warnedThresholds = new Set<number>();

  constructor(
    private readonly _hud: Hud,
    private readonly _worldSfx: WorldSfx,
  ) {}

  // 位置 r の高度を atmosphereBody の基準楕円体から測り、平滑化して警告を出す。大気天体が
  // いなければ「大気の底」が無いので何もしない。
  update(dt: number, r: Vec3, atmosphereBody: CelestialBody | null): void {
    const atm = atmosphereBody?.atmosphere ?? null;
    if (atm === null) return;
    this.step(dt, ellipsoidAltitude(sub(r, atmosphereBody!.state.r), atm));
  }

  // 平滑化を1歩進め、降下率としきい値の走破を見る。
  private step(dt: number, alt: number): void {
    if (!isFinite(this.altEma)) this.altEma = alt;
    const prevEma = this.altEma;
    const k = Math.min(1, dt / C.ALT_EMA_TIME_CONST);
    this.altEma += (alt - this.altEma) * k;
    if (dt > 1e-6) {
      const rate = (this.altEma - prevEma) / dt;
      this.altRateEma += (rate - this.altRateEma) * k;
    }
    if (this.altRateEma < C.ALT_DESCEND_WARN_RATE) this.descendWarned = true;
    else if (this.altRateEma > C.ALT_DESCEND_CLEAR_RATE) this.descendWarned = false;

    for (const threshold of C.ALT_WARN_THRESHOLDS) {
      if (this.altEma < threshold) {
        if (this.warnedThresholds.has(threshold)) continue;
        this.warnedThresholds.add(threshold);
        this._hud.hint(`警告: 高度が${Math.round(threshold / 1000)}km以下です`, 3000);
        this._worldSfx.altAlarm();
      } else if (this.altEma > threshold + C.ALT_WARN_HYSTERESIS) {
        this.warnedThresholds.delete(threshold);
      }
    }
  }
}
