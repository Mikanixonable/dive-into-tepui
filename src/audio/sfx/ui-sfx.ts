// ゲーム世界の外の操作・通知の合成効果音(アセット不要)。音源の位置という概念を持たず、
// どこでも一定音量で鳴る。AudioContext が unlock されるまでは無音のまま何もしない。
import { AudioEngine } from '../audio-engine';

export class UiSfx {
  constructor(private readonly engine: AudioEngine) {}

  // 時間warp切替・計画ノード操作・通知のブリップ。
  warp(): void {
    this.engine.tone(660, 0.06, 0.08, 'sine');
  }
}
