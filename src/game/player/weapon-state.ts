import { radiativeCooling, stepTemperature, stepThermalDeviation } from '../../physics/thermal';
import { ENV_TEMP, HULL_EMISS } from '../dynamic/dynamic-motion';
import { BARREL_RADIATING_AREA_PER_MASS, BARREL_SPECIFIC_HEAT } from '../dynamic/dynamic-entity/debris-motion';
import { MAG_ROUNDS } from './ammo-spec';

export const MAGS_PER_BARREL = 3; // 砲身1本で撃ち切るマガジン数
const BARREL_MASS = 300; // [kg]

export interface SerializedWeaponState {
  readonly mags: number;
  readonly rounds: number;
  readonly barrel: number;
  // 装着している砲身の平均温度 [K] と、薬室側が平均より高い温度差 [K]、発砲で砲身へ入り、まだ温度へ
  // 変えていない熱量 [J]。
  readonly barrelTemperature: number;
  readonly barrelDeviation: number;
  readonly pendingBarrelJoules: number;
  readonly cooldown: number;
  readonly muzzleIdx: number;
  readonly wasFiring: boolean;
  readonly wasEmptyClick: boolean;
}

// 艦の初期積載(予備マガジン数・装填済み残弾数)。
export interface AmmoLoad { readonly mags: number; readonly rounds: number }

export type AmmoConsumption = 'normal' | 'mag-reload' | 'barrel-reload';

export interface WeaponFireCommand {
  readonly consumption: AmmoConsumption;
  readonly muzzleIndex: number;
}

// 弾薬・砲身(温度を含む)・クールダウン・交互に撃つ砲口・トリガーの状態機械。
export class WeaponState {
  // barrel は装着中の砲身で撃てる残りのマガジン数、barrelDeviation は薬室側が平均より高い温度差 [K]、
  // pendingBarrelJoules は発砲で砲身へ入り、まだ温度へ変えていない熱量 [J]、muzzleIdx は次に撃つ砲口。
  // 省いた値は既定の積載と、環境温度の新しい砲身で始める。
  public constructor(
    private _mags = MAGS_PER_BARREL - 1,
    private _rounds = MAG_ROUNDS,
    private barrel = MAGS_PER_BARREL,
    private _barrelTemperature = ENV_TEMP,
    private _barrelDeviation = 0,
    private pendingBarrelJoules = 0,
    private _cooldown = 0,
    private _muzzleIdx = 0,
    private _wasFiring = false,
    private _wasEmptyClick = false,
  ) {}

  // 初期積載 ammo を積んで新しく作る。整数でないか範囲を外れた数は、既定の積載へフォールバックする。
  public static create(ammo: AmmoLoad): WeaponState {
    return new WeaponState(nonNegativeInteger(ammo.mags), boundedInteger(ammo.rounds, 0, MAG_ROUNDS));
  }

  // 直列化した弾薬・砲身の状態から復元する。壊れた値は既定値へフォールバックする。
  public static deserialize(serialized: SerializedWeaponState): WeaponState {
    // 壊れた値は undefined として渡し、コンストラクタの既定引数に補わせる
    return new WeaponState(
      nonNegativeInteger(serialized.mags),
      boundedInteger(serialized.rounds, 0, MAG_ROUNDS),
      boundedInteger(serialized.barrel, 0, MAGS_PER_BARREL),
      finiteNumber(serialized.barrelTemperature),
      finiteNumber(serialized.barrelDeviation),
      nonNegativeNumber(serialized.pendingBarrelJoules),
      nonNegativeNumber(serialized.cooldown),
      nonNegativeInteger(serialized.muzzleIdx),
      booleanValue(serialized.wasFiring),
      booleanValue(serialized.wasEmptyClick),
    );
  }

  public get mags(): number { return this._mags; }
  public get rounds(): number { return this._rounds; }
  public get barrelTemperature(): number { return this._barrelTemperature; }
  public get barrelDeviation(): number { return this._barrelDeviation; }
  public get cooldown(): number { return this._cooldown; }
  public get muzzleIdx(): number { return this._muzzleIdx; }
  // トリガーを引き続けているか。
  public get wasFiring(): boolean { return this._wasFiring; }
  // 撃てないまま引いたことを、次に撃てるまでに記録済みか。
  public get wasEmptyClick(): boolean { return this._wasEmptyClick; }

  // 装填中か予備に弾が残っているか。
  public get left(): boolean { return this._rounds > 0 || this._mags > 0; }

  // クールダウンを dt 秒ぶん減らす。0 で止まる。
  public tickCooldown(dt: number): void {
    if (this._cooldown > 0) this._cooldown = Math.max(0, this._cooldown - Math.max(0, dt));
  }

  // 次の発射までのクールダウンを seconds [s] にする。
  public setCooldown(seconds: number): void {
    this._cooldown = seconds;
  }

  // トリガーを引いた状態へ移行し、空撃ち記録フラグをリセットする。
  public pullTrigger(): void {
    this._wasFiring = true;
    this._wasEmptyClick = false;
  }

  // トリガーを離した状態にする。
  public releaseTrigger(): void {
    this._wasFiring = false;
  }

  // 撃てないまま引いたことを記録済みにする。
  public markEmptyClick(): void {
    this._wasEmptyClick = true;
  }

  // 次の1発が弾をどう消費するか。マガジンを撃ち尽くせば次のマガジンを装填し(mag-reload)、砲身の
  // 全マガジンを撃ち尽くせば砲身を替える(barrel-reload)。
  private nextConsumption(): AmmoConsumption {
    if (this._rounds > 1 || this._mags <= 0) return 'normal';
    return this.barrel > 1 ? 'mag-reload' : 'barrel-reload';
  }

  // muzzleCount 本の砲口を交互に使うときの、次の1発の弾の消費と撃つ砲口。撃てなければ null。
  public nextShot(muzzleCount: number): WeaponFireCommand | null {
    if (muzzleCount <= 0 || !this.left) return null;
    return { consumption: this.nextConsumption(), muzzleIndex: this._muzzleIdx % muzzleCount };
  }

  // 次の1発(nextShot)を撃ち、弾を消費して砲口を次へ移す。撃てなければ何もしない。
  public fire(muzzleCount: number): void {
    const shot = this.nextShot(muzzleCount);
    if (shot === null) return;
    this._muzzleIdx = (shot.muzzleIndex + 1) % muzzleCount;
    this._rounds--;
    if (shot.consumption === 'normal') return;
    // 予備のマガジンを装填し、この砲身で撃てる残りのマガジン数を減らす。撃ち尽くした砲身は替える。
    this._mags--;
    this._rounds = MAG_ROUNDS;
    this.barrel = shot.consumption === 'mag-reload' ? this.barrel - 1 : MAGS_PER_BARREL;
  }

  // クールダウン中でなく、予備があり装填中のマガジンに補充の余地があれば、マガジンと砲身を替えて
  // true を返す。
  public manualReload(): boolean {
    if (this._cooldown > 0 || this._mags <= 0 || this._rounds >= MAG_ROUNDS) return false;
    this._mags--;
    this._rounds = MAG_ROUNDS;
    this.barrel = MAGS_PER_BARREL;
    return true;
  }

  // mags が有限な正の数なら予備へ足し、弾切れならそのうち1個をそのまま装填する。
  public addMags(mags: number): void {
    if (!Number.isFinite(mags) || mags <= 0) return;
    this._mags += mags;
    if (this._rounds <= 0) {
      this._mags--;
      this._rounds = MAG_ROUNDS;
    }
  }

  // 発砲で砲身へ入った熱量 joules [J] を積む。次の stepBarrelThermal で一度だけ温度へ変わる。
  public addBarrelHeat(joules: number): void {
    this.pendingBarrelJoules += joules;
  }

  // 装着している砲身の温度を dt だけ進める。発砲で入った熱は刻みの分け方に依らず一度だけ
  // 温度へ変わり、薬室側には平均の 2 倍の温度上昇として乗る(SPEC/FLIGHT.md「熱管理」)。
  public stepBarrelThermal(dt: number): void {
    // 放射で冷え、温度差は薄まる。
    const cooling = radiativeCooling(
      this._barrelTemperature, ENV_TEMP, HULL_EMISS, BARREL_RADIATING_AREA_PER_MASS,
      BARREL_SPECIFIC_HEAT, dt);
    this._barrelTemperature = stepTemperature(
      this._barrelTemperature, -cooling, BARREL_SPECIFIC_HEAT, dt);
    this._barrelDeviation = stepThermalDeviation(
      this._barrelDeviation, this._barrelTemperature, HULL_EMISS,
      BARREL_RADIATING_AREA_PER_MASS, BARREL_SPECIFIC_HEAT, dt);
    // 溜まっていた発射ガスの熱を、この区間で一度だけ温度へ変える。
    if (this.pendingBarrelJoules === 0) return;
    const rise = this.pendingBarrelJoules / (BARREL_MASS * BARREL_SPECIFIC_HEAT);
    this._barrelTemperature += rise;
    this._barrelDeviation += rise;
    this.pendingBarrelJoules = 0;
  }

  // 装着している砲身を、環境温度の新しい砲身へ替える。
  public mountFreshBarrel(): void {
    this._barrelTemperature = ENV_TEMP;
    this._barrelDeviation = 0;
    this.pendingBarrelJoules = 0;
  }

  // 弾薬・砲身・砲口と、トリガーの引き続けの直列化。
  public serialize(): SerializedWeaponState {
    return {
      // 弾薬と砲身
      mags: this._mags,
      rounds: this._rounds,
      barrel: this.barrel,
      barrelTemperature: this._barrelTemperature,
      barrelDeviation: this._barrelDeviation,
      pendingBarrelJoules: this.pendingBarrelJoules,
      // 発射サイクルとトリガー
      cooldown: this._cooldown,
      muzzleIdx: this._muzzleIdx,
      wasFiring: this._wasFiring,
      wasEmptyClick: this._wasEmptyClick,
    };
  }
}

// 真偽値ならその値、そうでなければ既定値へフォールバックするための undefined。
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// 有限な数ならその値、そうでなければ既定値へフォールバックするための undefined。
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// 有限な非負の数ならその値、そうでなければ undefined。
function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

// 非負の整数ならその値、そうでなければ undefined。
function nonNegativeInteger(value: unknown): number | undefined {
  const number = nonNegativeNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

// min..max の整数ならその値、そうでなければ undefined。
function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  const number = nonNegativeInteger(value);
  return number !== undefined && number >= min && number <= max ? number : undefined;
}
