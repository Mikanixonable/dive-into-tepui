// 大気飛行の危険の監視: 自機の空力加熱/動圧と高度低下警告。
// game.ts を import しない — 依存は constructor 注入(Hud/Sfx)と各メソッド引数のみ。
import { R_EARTH } from '../physics/orbital';
import { airspeed } from '../physics/envaccel';
import { Vec3, len } from '../physics/vec3';
import { atmosphericDensity } from '../physics/atmosphere';
import * as C from './const';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';

// checkThermalLimits の戻り値: 限界超過の種別。null なら超過なし。
// 破壊(destroyShip の呼び出し)は combat.ts へのアクセスを持つ game.ts 側が行う。
export type ThermalLimit = 'heat' | 'dynpressure' | null;

export class ThermalSystem {
  // --- 自機の熱・動圧状態 ---
  hullTemp = C.HULL_START_TEMP;
  qdyn = 0;
  private heatWarned = false;

  // --- 高度警告(EMA平滑化)状態 ---
  private altEma = NaN; // 高度の指数移動平均(離心率によるふらつきを均す)
  private altRateEma = 0; // 高度変化率の指数移動平均 [m/s]
  altDescendWarned = false;
  // 既に警告済みのしきい値(降順走破)。しきい値+ヒステリシスまで登り返すと解除され、
  // 再度潜った際に同じしきい値で再警告できる
  private altWarnedThresholds = new Set<number>();

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
  ) {}

  // 対気速度から動圧と外殻温度を更新する。加熱はよどみ点熱流束の
  // Sutton–Graves 近似 q̇ = k·√(ρ/Rn)·v³、冷却はステファン・ボルツマン放射。
  updateThermal(dtSub: number, r: Vec3, v: Vec3): void {
    const rho = atmosphericDensity(len(r) - R_EARTH);
    const vr = airspeed(r, v);
    const s = len(vr);
    this.qdyn = 0.5 * rho * s * s;
    const qdot = C.SG_CONST * Math.sqrt(rho / C.NOSE_RADIUS) * s * s * s;
    const cool =
      C.HULL_EMISS *
      C.STEFAN_BOLTZMANN *
      C.RAD_AREA *
      (Math.pow(C.ENV_TEMP, 4) - Math.pow(this.hullTemp, 4));
    this.hullTemp = Math.max(
      C.HULL_TEMP_FLOOR,
      this.hullTemp + ((qdot * C.HEAT_ABSORB_AREA + cool) / C.HEAT_CAPACITY) * dtSub,
    );
  }

  // 熱防御の飽和・空力破壊の判定と警告表示。限界超過時は種別を返すのみで、
  // 実際の破壊(combat.destroyShip の呼び出し)は game.ts 側が行う。
  checkThermalLimits(): ThermalLimit {
    if (this.hullTemp > C.MAX_HULL_TEMP) {
      return 'heat';
    }
    if (this.qdyn > C.MAX_DYN_PRESSURE) {
      return 'dynpressure';
    }
    const hot = this.hullTemp > 0.7 * C.MAX_HULL_TEMP || this.qdyn > 0.5 * C.MAX_DYN_PRESSURE;
    if (hot && !this.heatWarned) {
      this.heatWarned = true;
      this.hud.hint('警告: 空力加熱・動圧が危険域 — 高度を上げよ', 4000);
    } else if (!hot && this.hullTemp < 0.6 * C.MAX_HULL_TEMP) {
      this.heatWarned = false;
    }
    return null;
  }

  // 高度低下(降下)の検知と警告。離心率による短周期の高度振動で誤反応しないよう
  // 高度・変化率とも指数移動平均で平滑化する(時定数 約3秒)。
  updateAltitudeAlarm(dt: number, playerAlive: boolean, alt: number): ThermalLimit {
    if (!playerAlive) return null;
    if (!isFinite(this.altEma)) this.altEma = alt;
    const prevEma = this.altEma;
    const k = Math.min(1, dt / C.ALT_EMA_TIME_CONST);
    this.altEma += (alt - this.altEma) * k;
    if (dt > 1e-6) {
      const rate = (this.altEma - prevEma) / dt;
      this.altRateEma += (rate - this.altRateEma) * k;
    }
    if (this.altRateEma < C.ALT_DESCEND_WARN_RATE) {
      this.altDescendWarned = true;
    } else if (this.altRateEma > C.ALT_DESCEND_CLEAR_RATE) {
      this.altDescendWarned = false;
    }

    // しきい値(120km/100km/80km)を下から上まで一つずつ跨いだタイミングで警告する。
    // EMA 高度なので離心率によるふらつきでは誤爆しにくい。しきい値+ヒステリシスまで
    // 登り返すと解除し、再降下時に同じしきい値で再警告できるようにする。
    const HYSTERESIS = C.ALT_WARN_HYSTERESIS; // [m]
    for (const th of C.ALT_WARN_THRESHOLDS) {
      if (this.altEma < th) {
        if (!this.altWarnedThresholds.has(th)) {
          this.altWarnedThresholds.add(th);
          this.hud.hint(`警告: 高度が${Math.round(th / 1000)}km以下です`, 3000);
          this.sfx.altAlarm();
        }
      } else if (this.altEma > th + HYSTERESIS) {
        this.altWarnedThresholds.delete(th);
      }
    }

    return this.checkThermalLimits();
  }
}
