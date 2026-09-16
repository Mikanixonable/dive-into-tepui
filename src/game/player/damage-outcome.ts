// 被弾・接触・焼失の帰結をステージへ記録する最小ポート。
// StageOutcome 自体を物理・演出処理へ渡さず、Player のライフサイクル結果だけを通知する。
export interface DamageOutcomeSink {
  playerLost(reason: string): void;
}
