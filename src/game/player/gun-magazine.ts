// 機関砲1門の弾薬の遷移。弾薬は武装モジュール(WeaponInstance)が持ち(SPEC COMBAT.md「機関砲の数と
// 弾薬の持ち主」)、ここはその消費・装填・補給の規則だけを書く。
import { MAG_ROUNDS } from './ammo-spec';
import type { WeaponInstance } from '../ship/ship-module-instance';

// 1門の弾薬。装填中のマガジンの残弾 rounds と予備マガジンの本数 mags。
export type GunAmmo = Pick<WeaponInstance, 'rounds' | 'mags'>;

// 艦の初期積載(1門ぶんの予備マガジン数・装填済み残弾数)。
export interface AmmoLoad { readonly mags: number; readonly rounds: number }

// 1発の弾の消費のしかた。マガジンを撃ち尽くして次を装填したら 'mag-reload'。
export type RoundConsumption = 'normal' | 'mag-reload';

// 健全な砲を合わせた弾薬。capacity は装填中のマガジンの装弾数の合計。
export interface AmmoTotals {
  readonly rounds: number;
  readonly mags: number;
  readonly capacity: number;
}

// 装填中か予備に弾が残っているか。
export function hasAmmo(gun: GunAmmo): boolean {
  return gun.rounds > 0 || gun.mags > 0;
}

// gun の弾薬を load で置き換える。整数でないか範囲を外れた数は 0 へ丸める。
export function loadAmmo(gun: GunAmmo, load: AmmoLoad): void {
  gun.rounds = countIn(load.rounds, MAG_ROUNDS);
  gun.mags = countIn(load.mags, Number.MAX_SAFE_INTEGER);
}

// 1発ぶん弾を消費する。撃ち尽くしたマガジンの外枠は捨て、予備があれば次を継ぎ目なく装填する。
// 弾が無ければ何もせず null。
export function consumeRound(gun: GunAmmo): RoundConsumption | null {
  if (!hasAmmo(gun)) return null;
  if (gun.rounds <= 0) loadSpare(gun);
  gun.rounds--;
  if (gun.rounds > 0 || gun.mags <= 0) return 'normal';
  loadSpare(gun);
  return 'mag-reload';
}

// 予備があり装填中のマガジンに補充の余地があれば、マガジンを替えて true を返す。
export function swapMagazine(gun: GunAmmo): boolean {
  if (gun.mags <= 0 || gun.rounds >= MAG_ROUNDS) return false;
  loadSpare(gun);
  return true;
}

// 補給の mags 本を、予備の最も少ない砲へ1本ずつ入れる。予備数が同じなら guns の並びで先の砲へ入れ、
// 装填中の残弾が 0 の砲へはそのまま装填する(SPEC COMBAT.md「補給」)。
export function supplyMagazines(guns: readonly GunAmmo[], mags: number): void {
  if (!Number.isFinite(mags)) return;
  for (let i = 0; i < Math.floor(mags); i++) {
    // 予備の最も少ない砲を、並びの先を優先して選ぶ。
    let target: GunAmmo | null = null;
    for (const gun of guns) {
      if (target === null || gun.mags < target.mags) target = gun;
    }
    if (target === null) return;
    if (target.rounds <= 0) target.rounds = MAG_ROUNDS;
    else target.mags++;
  }
}

// guns を合わせた弾薬。
export function ammoTotals(guns: readonly GunAmmo[]): AmmoTotals {
  let rounds = 0, mags = 0;
  for (const gun of guns) {
    rounds += gun.rounds;
    mags += gun.mags;
  }
  return { rounds, mags, capacity: guns.length * MAG_ROUNDS };
}

// 予備のマガジンを1本装填する。装填中のマガジンの残りは捨てる。
function loadSpare(gun: GunAmmo): void {
  gun.mags--;
  gun.rounds = MAG_ROUNDS;
}

// 0 以上 max 以下の整数ならその値、そうでなければ 0。
function countIn(value: number, max: number): number {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
}
