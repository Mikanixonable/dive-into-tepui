// 1曲を、指定のステップから鳴らす作曲用の再生機。本番の TrackPlayback を、区間ループと
// ミュートを被せた Composer の上で回し、いま鳴っているステップを画面へ答える。
import { BgmTrack } from '../../src/audio/bgm/tracks/types';
import { createComposer } from '../../src/audio/bgm/composer-factory';
import { TrackPlayback } from '../../src/audio/bgm/track-playback';
import { Composer, ComposerNote } from '../../src/audio/bgm/composer';

const LOOKAHEAD_SEC = 0.6; // まとめて予約する先読みの幅
const PUMP_INTERVAL_MS = 120; // 予約を足しに行く間隔
const START_DELAY_SEC = 0.15; // 鳴らし始めるまでの余裕
const STOP_FADE_SEC = 0.08; // 止めるときのフェード

// 繰り返して聴きたい区間。to のステップまでを鳴らして from へ戻る。
export interface LoopRange {
  from: number;
  to: number;
}

// 曲の Composer へ、詰めるための都合を被せたもの。ステップ番号を区間ループの中へ畳み、
// ミュート中の楽器の音を落とす。
class LabComposer implements Composer {
  public constructor(
    private readonly source: Composer,
    private muted: ReadonlySet<string>,
    private loop: LoopRange | null,
  ) {}

  public get stepDurSec(): number {
    return this.source.stepDurSec;
  }

  public notesAt(step: number): readonly ComposerNote[] {
    return this.source.notesAt(this.loopedStep(step)).filter((note) => !this.muted.has(note.instrument));
  }

  // 鳴らさない楽器の id 一式。
  public setMuted(ids: Iterable<string>): void {
    this.muted = new Set(ids);
  }

  public setLoop(loop: LoopRange | null): void {
    this.loop = loop;
  }

  // 区間の終わりより先へ進んだステップ番号を、区間の中へ畳んで返す。
  public loopedStep(step: number): number {
    const loop = this.loop;
    if (!loop || step <= loop.to) return step;
    const span = loop.to - loop.from + 1;
    if (span <= 0) return loop.from;
    return loop.from + ((step - loop.from) % span);
  }
}

export class LabPlayer {
  private readonly master: GainNode;
  private composer: LabComposer | null = null;
  private playback: TrackPlayback | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startStep = 0;

  // volume は 0〜1 のユーザー音量。曲を跨いで生きるマスターゲインをここで組む。
  public constructor(private readonly ctx: AudioContext, volume: number) {
    this.master = ctx.createGain();
    this.master.gain.setValueAtTime(volume, ctx.currentTime);
    this.master.connect(ctx.destination);
  }

  public get isPlaying(): boolean {
    return this.playback !== null;
  }

  // いま鳴っているステップと、そのステップで鳴らした音の数。止まっていれば鳴らし出す位置。
  public get current(): { step: number; notes: number } {
    const composer = this.composer;
    const playback = this.playback;
    if (!composer || !playback) return { step: this.startStep, notes: 0 };
    // 予約は先読みのぶん先へ進んでいるので、まだ鳴り始めていないステップ数を差し引く。
    const pending = Math.ceil((playback.nextStepTime - this.ctx.currentTime) / composer.stepDurSec);
    const step = composer.loopedStep(Math.max(this.startStep, playback.nextStep - pending));
    return { step, notes: composer.notesAt(step).length };
  }

  public setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  public setMuted(ids: Iterable<string>): void {
    this.composer?.setMuted(ids);
  }

  public setLoop(loop: LoopRange | null): void {
    this.composer?.setLoop(loop);
  }

  // 鳴らしたままステップ位置だけを飛ばす。予約済みの音は取り消せないので、飛ぶ前の音が
  // 短く重なって鳴り終える。
  public seek(toStep: number): void {
    if (!this.playback) return;
    this.startStep = toStep;
    this.playback.seek(toStep, this.ctx.currentTime + START_DELAY_SEC);
  }

  // 曲を組み直して fromStep から鳴らす。muted と loop はこの再生の初期値で、以降は
  // setMuted / setLoop が差し替える。すでに鳴っていれば作り直す。
  public play(track: BgmTrack, fromStep: number, muted: Iterable<string>, loop: LoopRange | null): void {
    this.stop();
    const composer = new LabComposer(createComposer(track), new Set(muted), loop);
    const startTime = this.ctx.currentTime + START_DELAY_SEC;
    const playback = new TrackPlayback(this.ctx, composer, track.instruments, this.master, startTime);
    playback.seek(fromStep, startTime);
    this.composer = composer;
    this.playback = playback;
    this.startStep = fromStep;
    this.timer = setInterval(() => playback.scheduleUntil(this.ctx.currentTime + LOOKAHEAD_SEC), PUMP_INTERVAL_MS);
  }

  // 鳴らすのをやめる。予約済みの音を短く絞り、鳴り終えたところで音声グラフから外す。
  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const playback = this.playback;
    this.playback = null;
    this.composer = null;
    if (!playback) return;
    playback.fadeOut(STOP_FADE_SEC);
    const waitSec = Math.max(0, playback.soundingUntil - this.ctx.currentTime);
    setTimeout(() => playback.dispose(), waitSec * 1000);
  }
}
