// ゲーム世界の外の操作・通知を知らせる合成効果音。位置によらず一定の音量で鳴る。
import type { AudioEngine } from '../audio-engine';
import type { SoundCue } from './sound-cue';

// UI 効果音の種別。'warp' は時間加速の切り替え、計画ノード操作、通知音に対応する。
export type UiSound = 'warp';

export class UiSfx {
  // 鳴らした音のうち、最も新しい id。
  private lastCueId = -1;

  public constructor(private readonly engine: AudioEngine) {}

  // そのフレームに鳴らす音の宣言 cues を受け、まだ鳴らしていない id のものを鳴らす。
  public sync(cues: readonly SoundCue<UiSound>[]): void {
    for (const cue of cues) {
      if (cue.id <= this.lastCueId) continue;
      this.lastCueId = cue.id;
      this.engine.tone(660, 0.06, 0.08, 'sine');
    }
  }
}
