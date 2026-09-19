export interface SerializedScoreCounter {
  readonly shots: number;
  readonly hits: number;
  readonly kills: number;
  readonly losses: number;
  readonly totalEnemiesSpawned: number;
}

// 発射・命中・撃破・自然喪失の集計(純粋なカウンタ)。
export class ScoreCounter {
  // 渡した数から数え始める。省いた数は 0 から。
  public constructor(
    private _shots = 0,
    private _hits = 0,
    private _kills = 0,
    // 撃破以外で失われた敵の数(焼失・衝突・交戦圏からの離脱)。
    private _losses = 0,
    // ステージが出した敵の総数。アセットを待っていて、まだ実体化していない敵も数える。
    private _totalEnemiesSpawned = 0,
  ) {}

  public get shots(): number { return this._shots; }
  public get hits(): number { return this._hits; }
  public get kills(): number { return this._kills; }
  public get losses(): number { return this._losses; }
  public get totalEnemiesSpawned(): number { return this._totalEnemiesSpawned; }

  // 直列化した集計から復元する。
  public static deserialize(serialized: SerializedScoreCounter): ScoreCounter {
    const { shots, hits, kills, losses, totalEnemiesSpawned } = serialized;
    // null も欠けと同じく 0 から数える(既定引数は undefined でしか働かない)。
    return new ScoreCounter(
      shots ?? undefined, hits ?? undefined, kills ?? undefined, losses ?? undefined, totalEnemiesSpawned ?? undefined,
    );
  }

  public recordShot(): void { this._shots++; }
  public recordHit(): void { this._hits++; }
  public recordKill(): void { this._kills++; }
  public recordEnemyLoss(): void { this._losses++; }
  public recordSpawnEnemy(): void { this._totalEnemiesSpawned++; }

  // 集計を直列化した形へ畳む。
  public serialize(): SerializedScoreCounter {
    return {
      shots: this._shots,
      hits: this._hits,
      kills: this._kills,
      losses: this._losses,
      totalEnemiesSpawned: this._totalEnemiesSpawned,
    };
  }
}
