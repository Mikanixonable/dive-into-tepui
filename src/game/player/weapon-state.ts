import { MAG_ROUNDS } from './ammo-spec';

export const MAGS_PER_BARREL = 3; // 砲身1本で撃ち切るマガジン数
export const DEFAULT_BARREL_TEMPERATURE = 255; // 新しく作った武装の砲身の温度 [K]

export interface SerializedWeaponState {
  readonly mags: number;
  readonly rounds: number;
  readonly barrel: number;
  // 装着している砲身の平均温度 [K] と、薬室側が平均より高い温度差 [K]。
  readonly barrelTemperature: number;
  readonly barrelDeviation: number;
  readonly cooldown: number;
  readonly muzzleIdx: number;
  readonly wasFiring: boolean;
  readonly wasEmptyClick: boolean;
}

// 艦の初期積載(予備マガジン数・装填済み残弾数)。
export type AmmoLoad = { readonly mags: number; readonly rounds: number };

export type AmmoConsumption = 'empty' | 'normal' | 'mag-reload' | 'barrel-reload';

export interface WeaponFireCommand {
  readonly consumption: AmmoConsumption;
  readonly muzzleIndex: number;
}

// 弾薬・砲身(温度を含む)・クールダウン・交互に撃つ砲口の状態機械。
export class WeaponState {
  // 発砲で砲身へ入り、まだ温度へ変えていない熱量 [J]。
  public pendingBarrelJoules = 0;

  // barrel は装着中の砲身に残るマガジン数、barrelTemperature・barrelDeviation は砲身の平均温度と
  // 薬室側の温度差 [K]、muzzleIdx は次に撃つ砲口。wasFiring はトリガーを引き続けているか、
  // wasEmptyClick は撃てないまま引いたことを記録済みか。
  public constructor(
    public mags = MAGS_PER_BARREL - 1,
    public rounds = MAG_ROUNDS,
    public barrel = MAGS_PER_BARREL,
    public barrelTemperature = DEFAULT_BARREL_TEMPERATURE,
    public barrelDeviation = 0,
    public cooldown = 0,
    public muzzleIdx = 0,
    public wasFiring = false,
    public wasEmptyClick = false,
  ) {}

  // 初期積載 ammo を積んで新しく作る。整数でないか範囲を外れた数は、既定の積載へ落とす。
  public static create(ammo: AmmoLoad): WeaponState {
    return new WeaponState(nonNegativeInteger(ammo.mags), boundedInteger(ammo.rounds, 0, MAG_ROUNDS));
  }

  // 直列化した弾薬・砲身の状態から復元する。壊れた値は既定へ落とす。
  public static deserialize(serialized: SerializedWeaponState): WeaponState {
    // 壊れた値は undefined として渡し、コンストラクタの既定引数に補わせる
    return new WeaponState(
      nonNegativeInteger(serialized.mags),
      boundedInteger(serialized.rounds, 0, MAG_ROUNDS),
      boundedInteger(serialized.barrel, 0, MAGS_PER_BARREL),
      finiteNumber(serialized.barrelTemperature),
      finiteNumber(serialized.barrelDeviation),
      nonNegativeNumber(serialized.cooldown),
      boundedInteger(serialized.muzzleIdx, 0, 1),
      booleanValue(serialized.wasFiring),
      booleanValue(serialized.wasEmptyClick),
    );
  }

  // 装填中か予備に弾が残っているか。
  public get left(): boolean { return this.rounds > 0 || this.mags > 0; }

  // クールダウンを dt 秒ぶん減らす。0 で止まる。
  public tickCooldown(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - Math.max(0, dt));
  }

  // 1発を消費する。マガジンを撃ち尽くせば次のマガジンを装填し(mag-reload)、砲身の全マガジンを
  // 撃ち尽くせば砲身を替える(barrel-reload)。
  private consume(): AmmoConsumption {
    if (!this.left) return 'empty';
    this.rounds--;
    if (this.rounds > 0) return 'normal';
    if (this.mags <= 0) return 'normal';
    // 予備のマガジンを装填し、この砲身で撃てる残りのマガジン数を減らす
    this.mags--;
    this.rounds = MAG_ROUNDS;
    this.barrel--;
    if (this.barrel > 0) return 'mag-reload';
    this.barrel = MAGS_PER_BARREL;
    return 'barrel-reload';
  }

  // muzzleCount 本の砲口を交互に使って1発を消費し、消費の結果と撃つ砲口を返す。撃てなければ null。
  public beginShot(muzzleCount: number): WeaponFireCommand | null {
    if (muzzleCount <= 0 || !this.left) return null;
    const consumption = this.consume();
    const muzzleIndex = this.muzzleIdx % muzzleCount;
    this.muzzleIdx = (muzzleIndex + 1) % muzzleCount;
    return { consumption, muzzleIndex };
  }

  // クールダウン中でなく、予備があり装填中のマガジンに補充の余地があれば、マガジンと砲身を替えて
  // true を返す。
  public manualReload(): boolean {
    if (this.cooldown > 0 || this.mags <= 0 || this.rounds >= MAG_ROUNDS) return false;
    this.mags--;
    this.rounds = MAG_ROUNDS;
    this.barrel = MAGS_PER_BARREL;
    return true;
  }

  // mags が有限な正の数なら予備へ足し、弾切れならそのうち1個をそのまま装填する。
  public addMags(mags: number): void {
    if (!Number.isFinite(mags) || mags <= 0) return;
    this.mags += mags;
    if (this.rounds <= 0) {
      this.mags--;
      this.rounds = MAG_ROUNDS;
    }
  }

  // 弾薬・砲身・砲口と、トリガーの引き続けの直列化。
  public serialize(): SerializedWeaponState {
    return {
      mags: this.mags,
      rounds: this.rounds,
      barrel: this.barrel,
      barrelTemperature: this.barrelTemperature,
      barrelDeviation: this.barrelDeviation,
      cooldown: this.cooldown,
      muzzleIdx: this.muzzleIdx,
      // トリガーを引き続けているか、撃てないまま引いたことを記録済みか
      wasFiring: this.wasFiring,
      wasEmptyClick: this.wasEmptyClick,
    };
  }
}

// 真偽値ならその値、そうでなければ既定へ落とすための undefined。
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// 有限な数ならその値、そうでなければ既定へ落とすための undefined。
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
