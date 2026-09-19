// 操作の場と出来事から出す UI の効果音を、次の同期まで溜める。通し番号は溜めた順に振る。
import type { SoundCue } from '../audio/sfx/sound-cue';
import type { UiSound } from '../audio/sfx/ui-sfx';

export class UiSoundQueue {
  private nextId = 0;
  // 装置へまだ渡していない音(操作途中の状態)。
  private pending: SoundCue<UiSound>[] = [];

  // 溜めている音。
  public get cues(): readonly SoundCue<UiSound>[] { return this.pending; }

  // 鳴らす音 sound を1つ溜める。
  public push(sound: UiSound): void {
    this.pending.push({ id: this.nextId++, sound });
  }

  // 装置へ渡し終えた音を捨てる。
  public clear(): void {
    this.pending = [];
  }
}
