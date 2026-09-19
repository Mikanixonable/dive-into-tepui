// ゲーム世界の外の操作・通知の合成効果音(アセット不要)。音源の位置という概念を持たず、
// どこでも一定音量で鳴る。AudioContext が開くまでは無音のまま何もしない。
import type { AudioEngine } from '../audio-engine';
import type { SoundCue } from './sound-cue';

// UI の効果音の種類。warp は時間加速の切り替え・計画ノードの操作・通知のブリップ。
export type UiSound = 'warp';

export class UiSfx {
  // 鳴らした音のうち、最も新しい id。
  private lastCueId = -1;

  public constructor(private readonly engine: AudioEngine) {}

  // そのフレームに鳴らす音の宣言 cues を受け、まだ鳴らしていない id のものだけを鳴らす。
  public sync(cues: readonly SoundCue<UiSound>[]): void {
    for (const cue of cues) {
      if (cue.id <= this.lastCueId) continue;
      this.lastCueId = cue.id;
      this.engine.tone(660, 0.06, 0.08, 'sine');
    }
  }
}
