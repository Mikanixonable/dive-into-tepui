// 1曲ぶんの鳴っている状態。自分のゲイン(その曲だけのフェード用)・Composer・楽器一式・
// ステップ位置を持ち、与えられた時刻まで音を先読みでスケジュールする。
// どの曲をいつ鳴らすかと、ユーザー音量(マスターゲイン)は持ち主の責務。
import { Composer, ComposerNote } from './composer';
import { Instrument } from './instrument';
import { createInstrument } from './instrument-factory';
import { InstrumentDef } from './tracks/types';

export class TrackPlayback {
  private readonly gain: GainNode;
  private readonly instruments: Map<string, Instrument>;
  private step = 0;
  private nextTime: number;

  // destination は持ち主のマスターゲイン。最初のステップは startTime から刻み始める。
  // 楽器は曲の頭で一度だけ組み、以降は音符ごとに id で引く。
  constructor(
    private readonly ctx: AudioContext,
    private readonly composer: Composer,
    instruments: InstrumentDef[],
    destination: AudioNode,
    startTime: number,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(1, ctx.currentTime);
    this.gain.connect(destination);
    this.instruments = new Map(instruments.map((def) => [def.id, createInstrument(def, ctx, this.gain)]));
    if (this.instruments.size !== instruments.length) {
      throw new Error('BGM track declares duplicate instrument ids');
    }
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

  // 1音を、ステップ開始時刻 stepTime を基準に、指定された楽器へ渡す。
  private playNote(note: ComposerNote, stepTime: number): void {
    const instrument = this.instruments.get(note.instrument);
    if (instrument === undefined) {
      throw new Error(`BGM note references an undeclared instrument: ${note.instrument}`);
    }
    instrument.play(note.freq, stepTime + note.offsetSec, note.durationSec, note.velocity);
  }
}
