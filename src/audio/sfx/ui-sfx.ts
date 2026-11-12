// ゲーム世界の外の操作・通知を知らせる合成効果音。位置によらず一定の音量で鳴る。
import type { AudioEngine } from '../audio-engine';
import type { SoundCue } from './sound-cue';

// UI 効果音の種別。'warp' は時間加速の切り替え、計画ノード操作、通知音に対応する。
// 'construction-*' は建造中の操作音で、吸着・配置・撤去・不可・建造終了を聞き分ける(SPEC/AUDIO.md「操作音」)。
export type UiSound =
  | 'warp'
  | 'construction-snap'
  | 'construction-place'
  | 'construction-remove'
  | 'construction-deny'
  | 'construction-finish';

export class UiSfx {
  // 鳴らした音のうち、最も新しい id。
  private lastCueId = -1;

  public constructor(private readonly engine: AudioEngine) {}

  // そのフレームに鳴らす音の宣言 cues を受け、まだ鳴らしていない id のものを鳴らす。
  public sync(cues: readonly SoundCue<UiSound>[]): void {
    for (const cue of cues) {
      if (cue.id <= this.lastCueId) continue;
      this.lastCueId = cue.id;
      // TEMP-DEBUG: UI 音の発生を観測するための一時ログ。調査後に外す。
      console.debug('[ui-sfx]', cue.sound);
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
    }
  }

  // 短いブリップ。
  private warp(): void {
    this.engine.tone(660, 0.06, 0.08, 'sine');
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
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(280, t + 0.15);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.19);
    this.engine.noiseBurst(0.06, 'lowpass', 900, 0.05);
  }

  // 置けない操作: 低いブザーを2回鳴らす。
  private constructionDeny(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 160;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.05, t + 0.01);
    gain.gain.setValueAtTime(0.05, t + 0.06);
    gain.gain.linearRampToValueAtTime(0.0001, t + 0.075);
    gain.gain.setValueAtTime(0.0001, t + 0.11);
    gain.gain.linearRampToValueAtTime(0.05, t + 0.12);
    gain.gain.setValueAtTime(0.05, t + 0.17);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  // 建造終了: 上へ進む3音(C5 → E5 → G5)。
  private constructionFinish(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, t);
    osc.frequency.setValueAtTime(659.25, t + 0.09);
    osc.frequency.setValueAtTime(783.99, t + 0.18);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
    gain.gain.setValueAtTime(0.08, t + 0.26);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.37);
  }
}
