// 1曲を、指定のステップから鳴らす再生機。曲送りもフェードインも無い — 詰めたい所だけを
// 鳴らす道具なので。音を作る側(Composer と Instrument)は本番と同じものを読む。
//
// 刻みの進め方だけはここが自前で持つ。任意ステップからの開始と区間ループという、本番の
// TrackPlayback には無い要求のために要る。逆に言えばそれ以外は本番と同じでなければならず、
// 予約される音が TrackPlayback と一致することは検証で押さえてある。
import { BgmTrack } from '../../src/audio/bgm/tracks/types';
import { createComposer } from '../../src/audio/bgm/composer-factory';
import { createInstrument } from '../../src/audio/bgm/instrument-factory';
import { Composer } from '../../src/audio/bgm/composer';
import { Instrument } from '../../src/audio/bgm/instrument';

const LOOKAHEAD_SEC = 0.6; // 本番と同じ先読み幅。刻みの感触を揃える
const PUMP_INTERVAL_MS = 120;
const START_DELAY_SEC = 0.15;
const STOP_FADE_SEC = 0.08;

export interface LoopRange {
  from: number;
  to: number;
}

export class LabPlayer {
  private master: GainNode | null = null;
  private composer: Composer | null = null;
  private instruments = new Map<string, Instrument>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  // 予約した音の位置。表示は先読み位置ではなく「いま鳴っている所」を出したいので控える。
  private queue: { step: number; at: number; notes: number }[] = [];
  private sounding = { step: 0, notes: 0 };
  private muted = new Set<string>();
  private loop: LoopRange | null = null;
  private volume = 0.7;

  constructor(private readonly ctx: AudioContext) {}

  get isPlaying(): boolean {
    return this.timer !== null;
  }

  // いま鳴っているステップと、そのステップで実際に鳴らした音の数。
  get current(): { step: number; notes: number } {
    return this.sounding;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(Math.max(0.0001, v), this.ctx.currentTime, 0.02);
  }

  setMuted(ids: Iterable<string>): void {
    this.muted = new Set(ids);
  }

  setLoop(loop: LoopRange | null): void {
    this.loop = loop;
  }

  // 曲を組み直して fromStep から鳴らす。すでに鳴っていれば作り直す。
  play(track: BgmTrack, fromStep: number): void {
    this.stop();
    const master = this.ctx.createGain();
    master.gain.setValueAtTime(Math.max(0.0001, this.volume), this.ctx.currentTime);
    master.connect(this.ctx.destination);
    this.master = master;
    this.composer = createComposer(track);
    this.instruments = new Map(track.instruments.map((d) => [d.id, createInstrument(d, this.ctx, master)]));
    this.step = fromStep;
    this.nextTime = this.ctx.currentTime + START_DELAY_SEC;
    this.sounding = { step: fromStep, notes: 0 };
    this.queue = [];
    this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  // 鳴らすのをやめ、音声グラフから切り離す。まだ鳴っている音は短く絞ってから外す。
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const master = this.master;
    const instruments = [...this.instruments.values()];
    this.instruments = new Map();
    this.composer = null;
    this.queue = [];
    this.master = null;
    if (!master) return;
    master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, STOP_FADE_SEC / 3);
    setTimeout(() => {
      for (const inst of instruments) inst.dispose();
      master.disconnect();
    }, (STOP_FADE_SEC + 0.4) * 1000);
  }

  // 先読み幅ぶんの音を予約し、そのぶんステップを進める。区間ループはここで巻き戻す。
  pump(): void {
    const composer = this.composer;
    if (!composer) return;
    const deadline = this.ctx.currentTime + LOOKAHEAD_SEC;
    while (this.nextTime < deadline) {
      if (this.loop && this.step > this.loop.to) this.step = this.loop.from;
      let played = 0;
      for (const note of composer.notesAt(this.step)) {
        if (this.muted.has(note.instrument)) continue;
        const inst = this.instruments.get(note.instrument);
        if (inst === undefined) continue;
        inst.play(note.freq, this.nextTime + note.offsetSec, note.durationSec, note.velocity);
        played++;
      }
      this.queue.push({ step: this.step, at: this.nextTime, notes: played });
      this.step++;
      this.nextTime += composer.stepDurSec;
    }
    this.dropPast();
  }

  // 表示側から細かく呼ばれる。ポンプの間隔より滑らかに現在位置を進めるため。
  tick(): void {
    this.dropPast();
  }

  // 予約のうち、すでに鳴り始めたものを畳んで「いま鳴っている所」を更新する。
  private dropPast(): void {
    const now = this.ctx.currentTime;
    while (this.queue.length > 0 && this.queue[0]!.at <= now) {
      const entry = this.queue.shift()!;
      this.sounding = { step: entry.step, notes: entry.notes };
    }
  }
}
