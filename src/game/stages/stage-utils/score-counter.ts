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
    public shots = 0,
    public hits = 0,
    public kills = 0,
    // 非プレイヤー起因の喪失数(再突入・空力分解等)。
    public losses = 0,
    public totalEnemiesSpawned = 0,
  ) {}

  // 直列化した集計から復元する。
  public static deserialize(serialized: SerializedScoreCounter): ScoreCounter {
    const { shots, hits, kills, losses, totalEnemiesSpawned } = serialized;
    // null も欠けと同じく 0 から数える(既定引数は undefined でしか働かない)。
    return new ScoreCounter(
      shots ?? undefined, hits ?? undefined, kills ?? undefined, losses ?? undefined, totalEnemiesSpawned ?? undefined,
    );
  }

  public recordShot(): void { this.shots++; }
  public recordHit(): void { this.hits++; }
  public recordKill(): void { this.kills++; }
  public recordEnemyLoss(): void { this.losses++; }
  public recordSpawnEnemy(): void { this.totalEnemiesSpawned++; }

  // 集計を直列化した形へ畳む。
  public serialize(): SerializedScoreCounter {
    return {
      shots: this.shots,
      hits: this.hits,
      kills: this.kills,
      losses: this.losses,
      totalEnemiesSpawned: this.totalEnemiesSpawned,
    };
  }
}
