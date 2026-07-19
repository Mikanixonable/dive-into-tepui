// 環境モデル(大気抵抗 + J2 + 月・太陽の第三体摂動)・自機の空力加熱/動圧・
// 高度低下警告・地球影による日照率。天体暦(太陽・月の ECI 位置)もここで保持する。
// game.ts を import しない — 依存は constructor 注入(Hud/Sfx)と各メソッド引数のみ。
import {
  ExtraAccel,
  R_EARTH,
  SIDEREAL_DAY,
  j2AccelInto,
  thirdBodyAccelAdd,
} from '../physics/orbital';
import { MU_MOON, MU_SUN, moonPosition, sunPosition } from '../physics/ephemeris';
import { Vec3, addScaled, dot, len, norm, v3 } from '../physics/vec3';
import { atmosphericDensity } from '../physics/atmosphere';
import * as C from './const';
import { Hud } from './hud';
import { Sfx } from './audio';

const EARTH_OMEGA = (2 * Math.PI) / SIDEREAL_DAY; // 地球自転角速度 [rad/s](Y軸=北極まわり)

// makeEnvAccel ホットパス用スクラッチ(単一スレッド前提)
const J2_SCRATCH = v3();

// 地球と共回転する大気に対する対気速度: v - ω×r, ω = (0, ω, 0)
function airspeed(r: Vec3, v: Vec3): Vec3 {
  return v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
}

// checkThermalLimits の戻り値: 限界超過の種別。null なら超過なし。
// 破壊(destroyShip の呼び出し)は combat.ts へのアクセスを持つ game.ts 側が行う。
export type ThermalLimit = 'heat' | 'dynpressure' | null;

export class EnvironmentSystem {
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

  // --- 天体暦(初期位相はゲームごとにランダム) ---
  private sunDirV: Vec3 = v3(1, 0, 0);
  readonly sunPhase0 = 0; // 昼(太陽が+X側)から開始するように固定
  readonly moonPhase0 = Math.random() * Math.PI * 2;
  private sunPos: Vec3 = v3(1.496e11, 0, 0);
  private moonPos: Vec3 = v3(3.844e8, 0, 0);

  // 環境加速度 = 大気抵抗(種別ごとの弾道係数) + J2 + 月・太陽の第三体摂動
  readonly envShip = this.makeEnvAccel(C.SHIP_BCINV);
  readonly envBullet = this.makeEnvAccel(C.BULLET_BCINV);
  readonly envSmall = this.makeEnvAccel(C.SMALL_DEBRIS_BCINV);

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
  ) {}

  // 太陽方向の単位ベクトル(ライティング・影判定用)
  get sunDir(): Vec3 {
    return this.sunDirV;
  }

  // 太陽・月の ECI 位置を simTime から更新する
  updateEphemeris(simTime: number): void {
    this.sunPos = sunPosition(simTime, this.sunPhase0);
    this.moonPos = moonPosition(simTime, this.moonPhase0);
    this.sunDirV = norm(this.sunPos);
  }

  // 大気抵抗 + J2(地球扁平) + 月・太陽の第三体(潮汐)摂動を合成した環境加速度。
  // 天体位置はサブステップ更新の this.sunPos / moonPos を閉包で参照する。
  // この関数は RK4 の全ステージ × 全エンティティ × サブステップで呼ばれるホット
  // パスなので、大気抵抗は(専用の Vec3 を作らず)直接数値演算でインライン化し、
  // 割り当てを 1 個(戻り値ぶんのみ)に抑える。J2・第三体項は共有の純関数
  // (physics/orbital.ts、テストで数値検証済み)をそのまま使う。
  private makeEnvAccel(bcInv: number): ExtraAccel {
    return (r: Vec3, v: Vec3, out?: Vec3): Vec3 => {
      const acc = out ?? v3();
      const rho = atmosphericDensity(len(r) - R_EARTH);
      if (rho >= 1e-15) {
        const vrx = v.x - EARTH_OMEGA * r.z;
        const vry = v.y;
        const vrz = v.z + EARTH_OMEGA * r.x;
        const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
        acc.x = vrx * k;
        acc.y = vry * k;
        acc.z = vrz * k;
      } else {
        acc.x = 0;
        acc.y = 0;
        acc.z = 0;
      }
      // J2 は加算合成: j2AccelInto はスクラッチに書き、成分を acc へ足す
      const j = j2AccelInto(J2_SCRATCH, r);
      acc.x += j.x;
      acc.y += j.y;
      acc.z += j.z;
      thirdBodyAccelAdd(acc, r, this.sunPos, MU_SUN);
      thirdBodyAccelAdd(acc, r, this.moonPos, MU_MOON);
      return acc;
    };
  }

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
  checkThermalLimits(playerAlive: boolean): ThermalLimit {
    if (!playerAlive) return null;
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
  updateAltitudeAlarm(dt: number, playerAlive: boolean, alt: number): void {
    if (!playerAlive) return;
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
  }

  altitudeOf(r: Vec3): number {
    return len(r) - R_EARTH;
  }

  // 自機位置の地表影(円柱近似 + 縁のぼかし)による日照率 0..1
  shadowLitFactor(r: Vec3): number {
    const along = dot(r, this.sunDirV);
    if (along >= 0) return 1; // 太陽側
    const perp = len(addScaled(r, this.sunDirV, -along));
    return Math.min(1, Math.max(0, (perp - R_EARTH) / C.SHADOW_PENUMBRA));
  }
}
