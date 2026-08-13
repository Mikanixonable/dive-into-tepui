// 自機の熱収支(空力加熱・射撃発熱・放射冷却)と動圧・高度低下の監視。
import { R_EARTH } from '../../physics/solar-system';
import { airspeed } from '../../physics/atmosphere';
import { Vec3, len } from '../../physics/vec3';
import { atmosphericDensity } from '../../physics/atmosphere';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import type { ThermalSaveData } from '../save-data';

// checkThermalLimits の戻り値: 限界超過の種別。null なら超過なし。
// heat-aero: 空力加熱による飽和。heat-internal: 射撃発熱など大気のない状況での飽和。
export type ThermalLimit = 'heat-aero' | 'heat-internal' | 'dynpressure' | null;

export class ThermalSystem {
  // --- 自機の熱・動圧状態 ---
  hullTemp = C.HULL_START_TEMP;
  qdyn = 0;
  private heatWarned = false;
  private pendingHeat = 0; // 射撃・被弾など未反映の投入熱量 [J]
  private radiatorArea = 0; // ラジエーターによる追加放熱面積 [m^2]
  private radiatorSolarLoad = 0; // ラジエーターが受ける太陽入射 [W]

  // --- 高度警告(EMA平滑化)状態 ---
  private altEma = NaN; // 高度の指数移動平均(離心率によるふらつきを均す)
  private altRateEma = 0; // 高度変化率の指数移動平均 [m/s]
  altDescendWarned = false;
  // 既に警告済みのしきい値(降順走破)。しきい値+ヒステリシスまで登り返すと解除され、
  // 再度潜った際に同じしきい値で再警告できる
  private altWarnedThresholds = new Set<number>();

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    saved?: ThermalSaveData,
  ) {
    if (saved) {
      this.hullTemp = saved.hullTemp;
      this.pendingHeat = saved.pendingHeat;
    }
  }

  // 発砲 rounds 発ぶんの投入熱量を次の updateThermal 呼び出しへ持ち越す。
  addGunHeat(rounds: number): void {
    this.pendingHeat += rounds * C.GUN_HEAT_PER_ROUND;
  }

  // 被弾1発ぶんの投入熱量を次の updateThermal 呼び出しへ持ち越す。
  addImpactHeat(): void {
    this.pendingHeat += C.BULLET_IMPACT_HEAT;
  }

  // 今フレームのラジエーター放熱面積 [m^2] と太陽入射 [W] を設定する。次の updateThermal
  // (このフレームの全サブステップ)で使われる。
  setRadiatorLoad(area: number, solarLoad: number): void {
    this.radiatorArea = area;
    this.radiatorSolarLoad = solarLoad;
  }

  // 対気速度から動圧と外殻温度を更新する。加熱はよどみ点熱流束の
  // Sutton–Graves 近似 q̇ = k·√(ρ/Rn)·v³、冷却はステファン・ボルツマン放射。
  updateThermal(dtSub: number, r: Vec3, v: Vec3, ship: import('../game-entity/ship').Ship): void {
    // 大気密度・対気速度から動圧を求める
    const rho = atmosphericDensity(len(r) - R_EARTH);
    const vr = airspeed(r, v);
    const s = len(vr);
    this.qdyn = 0.5 * rho * s * s;
    // よどみ点加熱とステファン・ボルツマン冷却を合算し外殻温度を積分する
    const qdot = C.SG_CONST * Math.sqrt(rho / C.NOSE_RADIUS) * s * s * s;
    const cool =
      C.HULL_EMISS *
      C.STEFAN_BOLTZMANN *
      (C.RAD_AREA + this.radiatorArea) *
      (Math.pow(C.ENV_TEMP, 4) - Math.pow(this.hullTemp, 4));
    // 射撃・被弾の発熱はサブステップ回数・dtSub に依存しない量として貯めてあるので、
    // 空力加熱と違い dtSub を掛けずに一度だけ温度へ変換する
    const heatCapacity = ship.mass > 0 ? ship.mass * 100 : C.HEAT_CAPACITY; // 比熱 約100 J/kg/K
    
    this.hullTemp = Math.max(
      C.HULL_TEMP_FLOOR,
      this.hullTemp +
        ((qdot * C.HEAT_ABSORB_AREA + cool + this.radiatorSolarLoad) / heatCapacity) * dtSub +
        this.pendingHeat / heatCapacity,
    );
    this.pendingHeat = 0;
  }

  // 熱防御の飽和・空力破壊を判定し、限界超過の種別を返す。
  checkThermalLimits(): ThermalLimit {
    if (this.hullTemp > C.MAX_HULL_TEMP) {
      // 動圧の有無を大気の有無の指標として使い、加熱源(空力/射撃)を出し分ける
      return this.qdyn >= C.REENTRY_GLOW_MIN_Q ? 'heat-aero' : 'heat-internal';
    }
    if (this.qdyn > C.MAX_DYN_PRESSURE) {
      return 'dynpressure';
    }
    // 危険域(70%/50%)に入ったら1回だけ警告する
    const hot = this.hullTemp > 0.7 * C.MAX_HULL_TEMP || this.qdyn > 0.5 * C.MAX_DYN_PRESSURE;
    if (hot && !this.heatWarned) {
      this.heatWarned = true;
      this._hud.hint('警告: 空力加熱・動圧が危険域 — 高度を上げよ', 4000);
      this._sfx.altAlarm();
    } else if (!hot && this.hullTemp < 0.6 * C.MAX_HULL_TEMP) {
      this.heatWarned = false;
    }
    return null;
  }

  // 高度低下(降下)の検知と警告。離心率による短周期の高度振動で誤反応しないよう
  // 高度・変化率とも指数移動平均で平滑化する(時定数 約3秒)。
  updateAltitudeAlarm(dt: number, alt: number): ThermalLimit {
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
          this._hud.hint(`警告: 高度が${Math.round(th / 1000)}km以下です`, 3000);
          this._sfx.altAlarm();
        }
      } else if (this.altEma > th + HYSTERESIS) {
        this.altWarnedThresholds.delete(th);
      }
    }

    return this.checkThermalLimits();
  }

  serialize(): ThermalSaveData {
    return { hullTemp: this.hullTemp, pendingHeat: this.pendingHeat };
  }
}
