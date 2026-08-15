// 1曲ぶんの鳴っている状態。自分のゲイン(その曲だけのフェード用)・Composer・ステップ位置を持ち、
// 与えられた時刻まで音を先読みでスケジュールする。
// どの曲をいつ鳴らすかと、ユーザー音量(マスターゲイン)は持ち主の責務。
import { Composer, ComposerNote } from './composer';

export class TrackPlayback {
  private readonly gain: GainNode;
  private step = 0;
  private nextTime: number;

  // destination は持ち主のマスターゲイン。最初のステップは startTime から刻み始める。
  constructor(
    private readonly ctx: AudioContext,
    private readonly composer: Composer,
    destination: AudioNode,
    startTime: number,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(1, ctx.currentTime);
    this.gain.connect(destination);
    this.nextTime = startTime;
  }

  // 次に刻むステップの開始時刻。曲を差し替えるとき、continuous に繋ぐ側がここから始める。
  get nextStepTime(): number {
    return this.nextTime;
  }

  // deadline より前に始まる音をすべてスケジュールし、その分ステップを進める。
  scheduleUntil(deadline: number): void {
    while (this.nextTime < deadline) {
      for (const note of this.composer.notesAt(this.step)) this.playNote(note, this.nextTime);
      this.step++;
      this.nextTime += this.composer.stepDurSec;
    }
  }

  // 無音から sec 秒かけて立ち上げる。
  fadeIn(sec: number): void {
    const t = this.ctx.currentTime;
    this.gain.gain.setValueAtTime(0.0001, t);
    this.gain.gain.exponentialRampToValueAtTime(1, t + sec);
  }

  // sec 秒かけて無音へ落とす。スケジュール済みの音はこのゲインを通って一緒に減衰する。
  fadeOut(sec: number): void {
    this.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, sec / 3);
  }

  // 1音を、ステップ開始時刻 stepTime を基準にスケジュールする。
  private playNote(note: ComposerNote, stepTime: number): void {
    const ctx = this.ctx;
    const t = stepTime + note.offsetSec;
    const osc = ctx.createOscillator();
    osc.type = note.wave;
    osc.frequency.value = note.freq;
    // 立ち上がり~減衰のゲイン包絡を組み、クリックノイズを避ける
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(note.level, t + note.attackSec);
    gain.gain.exponentialRampToValueAtTime(0.001, t + note.durationSec);
    osc.connect(gain).connect(this.gain);
    osc.start(t);
    osc.stop(t + note.durationSec + 0.05);
  }
}
