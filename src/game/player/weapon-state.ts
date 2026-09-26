import { MAG_ROUNDS } from './ammo-spec';

export interface SerializedWeaponState {
  readonly mags: number;
  readonly rounds: number;
  readonly cooldown: number;
  readonly muzzleIdx: number;
  readonly wasFiring: boolean;
  readonly wasEmptyClick: boolean;
  readonly shots?: readonly SerializedWeaponShot[];
}

export interface SerializedWeaponShot {
  readonly moduleId: string;
  readonly muzzleIndex: number;
  readonly firedAt: number;
  readonly cycleDuration: number;
}

export type WeaponShotRecord = SerializedWeaponShot;

// 艦の初期積載(予備マガジン数・装填済み残弾数)。
export interface AmmoLoad { readonly mags: number; readonly rounds: number }

export type AmmoConsumption = 'normal' | 'mag-reload';

export interface WeaponFireCommand {
  readonly consumption: AmmoConsumption;
  readonly muzzleIndex: number;
}

// 既定の初期積載。開始時は3マガジンが連結された状態で、装填済みの1マガジン＋予備2本。
const DEFAULT_MAGS = 2;

// 弾薬・クールダウン・交互に撃つ砲口・トリガーの状態機械。
export class WeaponState {
  // mags は予備を含めて残っているマガジン数、muzzleIdx は次に撃つ砲口。
  // 省いた値は既定の積載で始める。
  public constructor(
    private _mags = DEFAULT_MAGS,
    private _rounds = MAG_ROUNDS,
    private _cooldown = 0,
    private _muzzleIdx = 0,
    private _wasFiring = false,
    private _wasEmptyClick = false,
  ) {}

  private readonly shotRecords = new Map<string, WeaponShotRecord>();

  // 初期積載 ammo を積んで新しく作る。整数でないか範囲を外れた数は、既定の積載へフォールバックする。
  public static create(ammo: AmmoLoad): WeaponState {
    return new WeaponState(nonNegativeInteger(ammo.mags), boundedInteger(ammo.rounds, 0, MAG_ROUNDS));
  }

  // 直列化した弾薬の状態から復元する。壊れた値は既定値へフォールバックする。
  public static deserialize(serialized: SerializedWeaponState): WeaponState {
    // 壊れた値は undefined として渡し、コンストラクタの既定引数に補わせる
    const weapon = new WeaponState(
      nonNegativeInteger(serialized.mags),
      boundedInteger(serialized.rounds, 0, MAG_ROUNDS),
      nonNegativeNumber(serialized.cooldown),
      nonNegativeInteger(serialized.muzzleIdx),
      booleanValue(serialized.wasFiring),
      booleanValue(serialized.wasEmptyClick),
    );
    weapon.restoreShotRecords(serialized.shots ?? null);
    return weapon;
  }

  public get mags(): number { return this._mags; }
  public get rounds(): number { return this._rounds; }
  public get cooldown(): number { return this._cooldown; }
  public get muzzleIdx(): number { return this._muzzleIdx; }
  // トリガーを引き続けているか。
  public get wasFiring(): boolean { return this._wasFiring; }
  // 撃てないまま引いたことを、次に撃てるまでに記録済みか。
  public get wasEmptyClick(): boolean { return this._wasEmptyClick; }

  // 直近の成功した発射を、砲口ごとに返す。
  public get recentShots(): readonly WeaponShotRecord[] { return [...this.shotRecords.values()]; }

  public recordShot(record: WeaponShotRecord): void {
    this.shotRecords.set(shotKey(record.moduleId, record.muzzleIndex), { ...record });
  }

  // 撤去・破壊された武装の発射記録を進行の位相で捨てる。
  public retainShotModules(moduleIds: ReadonlySet<string>): void {
    for (const [key, shot] of this.shotRecords) {
      if (!moduleIds.has(shot.moduleId)) this.shotRecords.delete(key);
    }
  }

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

  // 次の1発が弾をどう消費するか。マガジンを撃ち尽くせば次のマガジンを装填する(mag-reload)。
  private nextConsumption(): AmmoConsumption {
    if (this._rounds > 1 || this._mags <= 0) return 'normal';
    return 'mag-reload';
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
    // 撃ち尽くしたマガジンの外枠は捨て、予備のマガジンを装填する。
    this._mags--;
    this._rounds = MAG_ROUNDS;
  }

  // クールダウン中でなく、予備があり装填中のマガジンに補充の余地があれば、マガジンを替えて
  // true を返す。
  public manualReload(): boolean {
    if (this._cooldown > 0 || this._mags <= 0 || this._rounds >= MAG_ROUNDS) return false;
    this._mags--;
    this._rounds = MAG_ROUNDS;
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

  // 弾薬・砲口と、トリガーの引き続けの直列化。発射記録は空なら畳む。
  public serialize(): SerializedWeaponState {
    return {
      mags: this._mags,
      rounds: this._rounds,
      cooldown: this._cooldown,
      muzzleIdx: this._muzzleIdx,
      wasFiring: this._wasFiring,
      wasEmptyClick: this._wasEmptyClick,
      ...(this.shotRecords.size > 0 ? { shots: this.recentShots } : {}),
    };
  }

  private restoreShotRecords(records: readonly SerializedWeaponShot[] | null): void {
    if (!Array.isArray(records)) return;
    for (const candidate of records) {
      const record = validShotRecord(candidate);
      if (record !== null) this.recordShot(record);
    }
  }
}

function shotKey(moduleId: string, muzzleIndex: number): string {
  return `${moduleId}\u0000${muzzleIndex}`;
}

function validShotRecord(value: unknown): WeaponShotRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Partial<SerializedWeaponShot>;
  if (typeof record.moduleId !== 'string' || record.moduleId.length === 0) return null;
  const muzzleIndex = nonNegativeInteger(record.muzzleIndex);
  const firedAt = finiteNumber(record.firedAt);
  const cycleDuration = finiteNumber(record.cycleDuration);
  if (muzzleIndex === undefined || firedAt === undefined || cycleDuration === undefined || cycleDuration <= 0) return null;
  return { moduleId: record.moduleId, muzzleIndex, firedAt, cycleDuration };
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
