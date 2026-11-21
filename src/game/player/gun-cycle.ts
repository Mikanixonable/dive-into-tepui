// 機関砲1門の発射の時計。連射中の次の発射時刻・手動リロードの終わり・次に使う砲口・砲口ごとの直近の
// 発射を持つ。時刻はすべてシミュレーション時刻 [sim s]。

// 砲口1つの直近の発射。cycleDuration はその砲口が次に撃つまでの間隔 [s]。
export interface GunShotRecord {
  readonly moduleId: string;
  readonly muzzleIndex: number;
  readonly firedAt: number;
  readonly cycleDuration: number;
}

export interface SerializedGunCycle {
  readonly moduleId: string;
  readonly nextShotAt: number | null;
  readonly reloadUntil: number;
  readonly muzzleIdx: number;
  readonly shots: readonly Omit<GunShotRecord, 'moduleId'>[];
}

export class GunCycle {
  private _nextShotAt: number | null = null;
  private _reloadUntil = -Infinity;
  private muzzleIdx = 0;
  private readonly shots = new Map<number, GunShotRecord>();

  // 武装モジュール moduleId の時計を、撃っていない状態で始める。
  public constructor(public readonly moduleId: string) {}

  // 直列化した時計を復元する。壊れた値は撃っていない状態の値で補う。
  public static deserialize(serialized: SerializedGunCycle): GunCycle {
    const cycle = new GunCycle(serialized.moduleId);
    // 時刻・砲口・発射記録を1つずつ検査して取り込む。
    const next = serialized.nextShotAt;
    cycle._nextShotAt = typeof next === 'number' && Number.isFinite(next) ? next : null;
    if (Number.isFinite(serialized.reloadUntil)) cycle._reloadUntil = serialized.reloadUntil;
    if (Number.isInteger(serialized.muzzleIdx) && serialized.muzzleIdx >= 0) cycle.muzzleIdx = serialized.muzzleIdx;
    for (const shot of Array.isArray(serialized.shots) ? serialized.shots : []) {
      if (Number.isInteger(shot.muzzleIndex) && Number.isFinite(shot.firedAt) && shot.cycleDuration > 0) {
        cycle.recordShot({ ...shot, moduleId: serialized.moduleId });
      }
    }
    return cycle;
  }

  // 時計を直列化する。リロードしたことが無ければ終わりの時刻は 0 として残す。
  public serialize(): SerializedGunCycle {
    return {
      moduleId: this.moduleId,
      nextShotAt: this._nextShotAt,
      reloadUntil: Number.isFinite(this._reloadUntil) ? this._reloadUntil : 0,
      muzzleIdx: this.muzzleIdx,
      shots: [...this.shots.values()].map(({ muzzleIndex, firedAt, cycleDuration }) => ({
        muzzleIndex, firedAt, cycleDuration,
      })),
    };
  }

  // 連射中の次の発射時刻。撃っていなければ null。
  public get nextShotAt(): number | null { return this._nextShotAt; }
  public get recentShots(): Iterable<GunShotRecord> { return this.shots.values(); }

  // 時刻 t にリロード中か。
  public reloading(t: number): boolean { return t < this._reloadUntil; }

  // 時刻 t からリロードの終わりまでの残り [s]。
  public reloadRemaining(t: number): number { return Math.max(0, this._reloadUntil - t); }

  // 時刻 firstShotAt に最初の1発を撃つ連射を始める。
  public start(firstShotAt: number): void {
    this._nextShotAt = firstShotAt;
  }

  // 連射をやめる。次の start まで撃たない。
  public stop(): void {
    this._nextShotAt = null;
  }

  // 次の発射時刻を interval [s] 先へ送る。撃てなかった発射の時刻も送るので、連射の拍は崩れない。
  public advance(interval: number): void {
    if (this._nextShotAt !== null) this._nextShotAt += interval;
  }

  // 時刻 t から duration [s] のあいだリロードで撃たない。
  public beginReload(t: number, duration: number): void {
    this._reloadUntil = t + duration;
  }

  // muzzleCount 本の砲口を交互に使うときの、次に撃つ砲口。呼ぶたびに次へ移る。
  public takeMuzzle(muzzleCount: number): number {
    const index = this.muzzleIdx % muzzleCount;
    this.muzzleIdx = (index + 1) % muzzleCount;
    return index;
  }

  // 砲口の直近の発射を record で置き換える。
  public recordShot(record: GunShotRecord): void {
    this.shots.set(record.muzzleIndex, record);
  }
}
