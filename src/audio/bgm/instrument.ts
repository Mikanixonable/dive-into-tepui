// Composer からの演奏要求を受け、WebAudio ノードを用いて具体的な音響波形を合成・出力する楽器インターフェース。
export interface Instrument {
  // freq の音を、時刻 when から durationSec 秒間、強さ velocity(0..1) で鳴らす。
  // 減衰完了までのノード破棄も実装側の責務。
  play(freq: number, when: number, durationSec: number, velocity: number): void;

  // 再生終了時、保持している持続ノードを音声グラフから切り離す。
  dispose(): void;
}
