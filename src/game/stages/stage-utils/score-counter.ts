export interface SerializedScoreCounter {
  readonly shots: number;
  readonly hits: number;
  readonly kills: number;
  readonly losses: number;
  readonly totalEnemiesSpawned: number;
}

// 発射・命中・撃破・自然喪失の集計(純粋なカウンタ)。saved があればその値から始める。
export class ScoreCounter {
  public shots: number;
  public hits: number;
  public kills: number;
  // 非プレイヤー起因の喪失数(再突入・空力分解等)。
  public losses: number;
  public totalEnemiesSpawned: number;

  public constructor(saved?: SerializedScoreCounter) {
    this.shots = saved?.shots ?? 0;
    this.hits = saved?.hits ?? 0;
    this.kills = saved?.kills ?? 0;
    this.losses = saved?.losses ?? 0;
    this.totalEnemiesSpawned = saved?.totalEnemiesSpawned ?? 0;
  }

  public recordShot(): void { this.shots++; }
  public recordHit(): void { this.hits++; }
  public recordKill(): void { this.kills++; }
  public recordEnemyLoss(): void { this.losses++; }
  public recordSpawnEnemy(): void { this.totalEnemiesSpawned++; }

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
