// 発射・命中・撃破・自然喪失の集計(純粋なカウンタ)。勝利判定・通知・画面遷移といった
// 副作用は持たない — それらは StageDefinition.recordKill/recordKilled(stage-definition.ts)
// が担う。
export class KillCounter {
  shots = 0;
  hits = 0;
  kills = 0;
  // 非プレイヤー起因の喪失数(再突入・空力分解等)。勝利判定の残存数計算にのみ使う。
  losses = 0;

  recordShot(): void { this.shots++; }
  recordHit(): void { this.hits++; }
  recordKill(): void { this.kills++; }
  recordLoss(): void { this.losses++; }
}
