import type { ScoreCounterSaveData } from '../../save-data';

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

  serialize(): ScoreCounterSaveData {
    return {
      shots: this.shots,
      hits: this.hits,
      kills: this.kills,
      losses: this.losses,
      totalEnemiesSpawned: this.totalEnemiesSpawned,
    };
  }

  restore(data: ScoreCounterSaveData): void {
    this.shots = data.shots;
    this.hits = data.hits;
    this.kills = data.kills;
    this.losses = data.losses;
    this.totalEnemiesSpawned = data.totalEnemiesSpawned;
  }
}
