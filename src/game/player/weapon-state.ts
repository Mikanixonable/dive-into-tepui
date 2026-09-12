import { MAG_ROUNDS } from './ammo-spec';

export const MAGS_PER_BARREL = 3;
export const DEFAULT_BARREL_TEMPERATURE = 255;

export interface WeaponStateData {
  readonly mags: number;
  readonly rounds: number;
  readonly barrel: number;
  readonly barrelTemperature?: number;
  readonly barrelDeviation?: number;
  readonly cooldown: number;
  readonly muzzleIdx: number;
}

export type AmmoConsumption = 'empty' | 'normal' | 'mag-reload' | 'barrel-reload';

export interface WeaponFireCommand {
  readonly consumption: AmmoConsumption;
  readonly muzzleIndex: number;
}

// 弾薬・砲身・クールダウン・砲口交互状態だけを所有する純粋な状態機械。
// 発射に伴う弾体・音・閃光・得点などの副作用はここへ持ち込まない。
export class WeaponState {
  public rounds = MAG_ROUNDS;
  public mags = MAGS_PER_BARREL - 1;
  public barrel = MAGS_PER_BARREL;
  public barrelTemperature = DEFAULT_BARREL_TEMPERATURE;
  public barrelDeviation = 0;
  public pendingBarrelJoules = 0;
  public cooldown = 0;
  public wasFiring = false;
  public wasEmptyClick = false;
  public muzzleIdx = 0;

  public constructor(saved?: WeaponStateData, initial?: { readonly mags: number; readonly rounds: number }) {
    if (saved) {
      this.mags = nonNegativeInteger(saved.mags, this.mags);
      this.rounds = boundedInteger(saved.rounds, 0, MAG_ROUNDS, this.rounds);
      this.barrel = boundedInteger(saved.barrel, 0, MAGS_PER_BARREL, this.barrel);
      this.barrelTemperature = finiteNumber(saved.barrelTemperature, DEFAULT_BARREL_TEMPERATURE);
      this.barrelDeviation = finiteNumber(saved.barrelDeviation, 0);
      this.cooldown = nonNegativeNumber(saved.cooldown, 0);
      this.muzzleIdx = boundedInteger(saved.muzzleIdx, 0, 1, 0);
    } else if (initial) {
      this.mags = nonNegativeInteger(initial.mags, this.mags);
      this.rounds = boundedInteger(initial.rounds, 0, MAG_ROUNDS, this.rounds);
    }
  }

  public get left(): boolean { return this.rounds > 0 || this.mags > 0; }

  public tickCooldown(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - Math.max(0, dt));
  }

  public consume(): AmmoConsumption {
    if (!this.left) return 'empty';
    this.rounds--;
    if (this.rounds > 0) return 'normal';
    if (this.mags <= 0) return 'normal';
    this.mags--;
    this.rounds = MAG_ROUNDS;
    this.barrel--;
    if (this.barrel > 0) return 'mag-reload';
    this.barrel = MAGS_PER_BARREL;
    return 'barrel-reload';
  }

  // 状態遷移の結果だけを射撃側へ渡す。弾体や演出はこの型へ持ち込まない。
  public beginShot(muzzleCount: number): WeaponFireCommand | null {
    if (muzzleCount <= 0 || !this.left) return null;
    const consumption = this.consume();
    const muzzleIndex = this.muzzleIdx % muzzleCount;
    this.muzzleIdx = (muzzleIndex + 1) % muzzleCount;
    return { consumption, muzzleIndex };
  }

  public manualReload(): boolean {
    if (this.cooldown > 0 || this.mags <= 0 || this.rounds >= MAG_ROUNDS) return false;
    this.mags--;
    this.rounds = MAG_ROUNDS;
    this.barrel = MAGS_PER_BARREL;
    return true;
  }

  public addMags(mags: number): void {
    if (!Number.isFinite(mags) || mags <= 0) return;
    this.mags += mags;
    if (this.rounds <= 0) {
      this.mags--;
      this.rounds = MAG_ROUNDS;
    }
  }

  public serialize(): WeaponStateData {
    return {
      mags: this.mags,
      rounds: this.rounds,
      barrel: this.barrel,
      barrelTemperature: this.barrelTemperature,
      barrelDeviation: this.barrelDeviation,
      cooldown: this.cooldown,
      muzzleIdx: this.muzzleIdx,
    };
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return number >= 0 ? number : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = nonNegativeNumber(value, fallback);
  return Number.isInteger(number) ? number : fallback;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = nonNegativeInteger(value, fallback);
  return number >= min && number <= max ? number : fallback;
}
