// 発射・命中・撃破・自然喪失の集計(純粋なカウンタ)。
export class ScoreCounter {
  shots = 0;
  hits = 0;
  kills = 0;
  // 非プレイヤー起因の喪失数(再突入・空力分解等)。
  losses = 0;
  totalEnemiesSpawned = 0;

  recordShot(): void { this.shots++; }
  recordHit(): void { this.hits++; }
  recordKill(): void { this.kills++; }
  recordEnemyLoss(): void { this.losses++; }
  recordSpawnEnemy(): void { this.totalEnemiesSpawned++; }
}
