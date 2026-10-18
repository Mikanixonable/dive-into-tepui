// 警報(状態)の合成効果音。注意は短い1音、警告は短い二音で、位置によらず一定の音量で鳴る。
import type { AudioEngine } from '../audio-engine';
import type { SoundCue } from './sound-cue';

// 警報音の種類。
export type AlarmSound = 'caution' | 'warning';

export class AlarmSfx {
  // 鳴らした音のうち、最も新しい id。
  private lastCueId = -1;

  public constructor(private readonly engine: AudioEngine) {}

  // そのフレームに鳴らす音の宣言 cues を受け、まだ鳴らしていない id のものを鳴らす。
  public sync(cues: readonly SoundCue<AlarmSound>[]): void {
    for (const cue of cues) {
      if (cue.id <= this.lastCueId) continue;
      this.lastCueId = cue.id;
      this.play(cue.sound);
    }
  }

  // 警報音を1つ鳴らす。
  private play(sound: AlarmSound): void {
    if (sound === 'caution') {
      this.engine.tone(523.3, 0.18, 0.06, 'triangle');
      return;
    }
    // わずかに不協和にして警報らしいうなりを出す二音。
    this.engine.tone(392, 0.16, 0.09, 'square');
    this.engine.tone(415.3, 0.16, 0.07, 'square');
  }
}
