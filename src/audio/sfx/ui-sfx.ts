// ゲーム世界の外の操作・通知を知らせる合成効果音。位置によらず一定の音量で鳴る。
import type { AudioEngine } from '../audio-engine';
import type { SoundCue } from './sound-cue';

// UI 効果音の種別。'warp' は時間加速の切り替え、計画ノード操作、通知音に対応する。
// 'construction-*' は建造中の操作音で、吸着・配置・撤去・不可・建造終了を聞き分ける(SPEC/AUDIO.md「操作音」)。
// 'salvage-award' は鹵獲の授与を知らせる通知音(SPEC/AUDIO.md「操作音」、GAME.md 3.1)。
export type UiSound =
  | 'warp'
  | 'construction-snap'
  | 'construction-place'
  | 'construction-remove'
  | 'construction-deny'
  | 'construction-finish'
  | 'salvage-award';

export class UiSfx {
  // 鳴らした音のうち、最も新しい id。
  private lastCueId = -1;

  public constructor(private readonly engine: AudioEngine) {}

  // そのフレームに鳴らす音の宣言 cues を受け、まだ鳴らしていない id のものを鳴らす。
  public sync(cues: readonly SoundCue<UiSound>[]): void {
    for (const cue of cues) {
      if (cue.id <= this.lastCueId) continue;
      this.lastCueId = cue.id;
      this.play(cue.sound);
    }
  }

  // 一回きりの音を1つ鳴らす。
  private play(sound: UiSound): void {
    switch (sound) {
      case 'warp': this.warp(); return;
      case 'construction-snap': this.constructionSnap(); return;
      case 'construction-place': this.constructionPlace(); return;
      case 'construction-remove': this.constructionRemove(); return;
      case 'construction-deny': this.constructionDeny(); return;
      case 'construction-finish': this.constructionFinish(); return;
      case 'salvage-award': this.salvageAward(); return;
    }
  }

  // 短いブリップ。
  private warp(): void {
    this.engine.tone(440, 0.07, 0.08, 'sine');
    this.engine.tone(1320, 0.12, 0.02, 'sine');
    this.engine.tone(1320, 0.1, 0.012, 'sine', 0.12);
  }

  // 候補への吸着: 高く短いクリック。
  private constructionSnap(): void {
    this.engine.tone(2100, 0.035, 0.06, 'triangle');
    this.engine.tone(3100, 0.02, 0.03, 'triangle');
    this.engine.noiseBurst(0.02, 'highpass', 5500, 0.03);
  }

  // 配置: 金属が噛み合う低めの打撃と、かすかな高周波の残り。
  private constructionPlace(): void {
    this.engine.noiseBurst(0.09, 'lowpass', 450, 0.18);
    this.engine.tone(170, 0.08, 0.1, 'square');
    this.engine.tone(1350, 0.05, 0.035, 'triangle');
    this.engine.noiseBurst(0.04, 'highpass', 3200, 0.04);
  }

  // 撤去: 音高が下がっていく短い音と、軽い引き抜きのノイズ。
  private constructionRemove(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    // 音高: 880 → 280 Hz へ下げる。
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(280, t + 0.15);
    const gain = ctx.createGain();
    // 音量の包絡: 短く立って急速に減衰する。
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.19);
    // 引き抜きのノイズを重ねる。
    this.engine.noiseBurst(0.06, 'lowpass', 900, 0.05);
  }

  // 置けない操作: くぐもった木琴の2音と、かすかな倍音。
  private constructionDeny(): void {
    this.engine.tone(440, 0.1, 0.08, 'sine');
    this.engine.tone(880, 0.1, 0.025, 'sine');
    this.engine.tone(370, 0.12, 0.08, 'sine', 0.11);
  }

  // 鹵獲の授与: 柔らかく下降する2音と、高い倍音の残り。
  private salvageAward(): void {
    this.engine.tone(987, 0.09, 0.05, 'sine');
    this.engine.tone(740, 0.11, 0.05, 'sine', 0.09);
    this.engine.tone(1480, 0.3, 0.02, 'sine', 0.17);
  }

  // 建造終了: 温かい和音と、高い残響。
  private constructionFinish(): void {
    for (const f of [440, 554, 659]) this.engine.tone(f, 0.22, 0.05, 'sine');
    this.engine.tone(880, 0.3, 0.02, 'sine', 0.15);
  }
}
