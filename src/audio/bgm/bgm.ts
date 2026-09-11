// BGM の公開窓口。ユーザー音量をマスターゲインとして持ち、音楽の線(Conductor)を束ねて、
// 唯一の先読みタイマーでそれらを進める。どの曲をいつ鳴らすかは線それぞれの責務。
// 線は2本ある: ゲーム中の BGM と、設定パネルでの試聴。互いのノード鎖は独立していて、
// 試聴はゲーム側の状態に触れない — 設定パネルを開いている間ゲーム側は伏せておき、
// 閉じたら試聴の線を畳んでゲーム側を戻す。
// ゲインは3層: マスター(ユーザー音量)、線ごと(その線を伏せる)、曲ごと(その曲のフェード)。
// 1つのノードに兼ねさせると、書き手の違う操作が同じ AudioParam を奪い合い、後の呼び出しが
// 前の形を打ち消すので、層を分けて持つ。
import { BGM_TRACKS } from './tracks/tracks';
import { Conductor } from './conductor';
import { AudioEngine } from '../audio-engine';
import { trackCycleDurationSec } from './track-cycle';

const PUMP_INTERVAL_MS = 120; // スケジューラを回す間隔
const LOOKAHEAD_SEC = 0.6; // この先ぶんまでまとめてスケジュールし、タイマー精度に依存しないようにする
const AUDITION_FADE_SEC = 0.15; // 試聴を切り替える・止めるときのフェード

// 保存が無いときのユーザー音量。
export const DEFAULT_BGM_VOLUME = 1;

// 保存された文字列をユーザー音量へ読み直す。数として読めない値は既定へ落とし、読めた値は 0〜1 へ収める。
export function parseBgmVolume(text: string | null): number {
  if (text === null) return DEFAULT_BGM_VOLUME;
  const vol = Number.parseFloat(text);
  if (Number.isNaN(vol)) return DEFAULT_BGM_VOLUME;
  return Math.min(1, Math.max(0, vol));
}

// ユーザー音量を保存文字列へ書き出す。
export function formatBgmVolume(vol: number): string {
  return String(vol);
}

export class Bgm {
  private masterGain: GainNode | null = null;
  private ambient: Conductor | null = null;
  private audition: Conductor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  // volume は鳴らし始めるときのユーザー音量 [0〜1]。
  public constructor(private readonly engine: AudioEngine, private volume: number) {}

  // === 共通 (conductor によらない操作) ===

  // ユーザー音量を差し替える。再生中なら即反映し、停止中に正の音量へ上げたら再生を始める。
  public setVolume(vol: number): void {
    this.volume = vol;
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(Math.max(0.0001, vol), ctx.currentTime, 0.1);
    }
    if (vol > 0) this.start();
  }

  // ユーザー音量を表すマスターゲイン。線を跨いで生き続ける唯一のノード。
  private ensureMasterGain(ctx: AudioContext): GainNode {
    if (this.masterGain) return this.masterGain;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, this.volume), ctx.currentTime);
    g.connect(ctx.destination);
    this.masterGain = g;
    return g;
  }

  // どれかの線が鳴っている間だけ刻みを回す。
  private syncPump(): void {
    const sounding = (this.ambient?.isSounding ?? false) || (this.audition?.isSounding ?? false);
    if (sounding && !this.timer) {
      this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
    } else if (!sounding && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 先読み時間の範囲まで、動いている線をすべて刻み進める。
  private pump(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const deadline = ctx.currentTime + LOOKAHEAD_SEC;
    this.ambient?.advance(deadline);
    this.audition?.advance(deadline);
  }

  // === ゲーム内BGM (ambient conductor) ===
  // これが既定の conductor なので、特別扱いとし、関連するメソッド名から目的語 (ambient) を省く。

  // 伏せる指示。線は最初に鳴らすときまで組まれないので、その間の指示をここで覚えておく。
  private paused = false;
  // 一度きりの自動開始を使い切ったか。
  private autoStartUsed = false;

  // ゲーム内 BGM を開く。すでに鳴っていれば何もしない。
  private start(trackIdx?: number): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const line = this.ensureAmbient(ctx);
    if (line.isSounding) return;
    line.start(trackIdx);
    this.syncPump();
  }

  // 最初のユーザー操作から呼ばれ、ゲーム内 BGM を一度だけ始める。この操作はキー入力・
  // ポインタ入力のたびに飛ぶので、二度目以降は何もしない — 決着で止めた BGM が、次の
  // キー入力で蘇らないため。
  public ensureStarted(): void {
    if (this.autoStartUsed || !this.engine.ctx) return;
    this.autoStartUsed = true;
    if (this.volume > 0) this.start();
  }

  // ゲーム内 BGM を再開する。直前に鳴らしていた曲から始める。
  public resume(): void {
    const ctx = this.engine.ctx;
    if (this.volume <= 0 || !ctx) return;
    this.start(this.ensureAmbient(ctx).currentTrackIndex);
  }

  // ゲーム中の BGM の線。AudioContext ができるまでは組めないので、最初に鳴らすときに作る。
  private ensureAmbient(ctx: AudioContext): Conductor {
    if (!this.ambient) {
      this.ambient = new Conductor(ctx, this.ensureMasterGain(ctx), true);
      if (this.paused) this.ambient.pause();
    }
    return this.ambient;
  }

  // ゲーム中の BGM を fadeSec 秒かけてフェードアウトする。
  public stop(fadeSec = 2.5): void {
    this.ambient?.stop(fadeSec);
    this.syncPump();
  }

  // === 試聴用 BGM (audition conductor) ===
  // begin/end は設定パネルの開閉そのもので、試聴の線とゲーム内 BGM の両方に効く。

  // 設定パネルが開いた。ゲーム内 BGM を伏せ、試聴だけが聞こえる状態にする。
  // まだ線が無ければ、組まれたときに伏せた状態から始める。
  public beginAudition(): void {
    this.paused = true;
    this.ambient?.pause();
  }


  // 指定した曲を先頭から試聴する。AudioContext の unlock も最初のクリックで行う。
  // 試聴の線は曲送りしないので、選んだ曲がそのまま鳴り続ける。
  public playAudition(index: number): void {
    this.engine.unlock();
    const ctx = this.engine.ctx;
    if (!ctx || BGM_TRACKS.length === 0) return;
    this.disposeAudition();
    this.audition = new Conductor(ctx, this.ensureMasterGain(ctx), false);
    this.audition.start(index);
    this.syncPump();
  }

  // 試聴を止める。設定パネルは開いたままなので、ゲーム中の BGM は伏せたまま。
  public stopAudition(): void {
    this.disposeAudition();
    this.syncPump();
  }

  // 試聴中の曲を、一巡の中の timeSec 秒の位置へ飛ばす。試聴していなければ何もしない。
  public seekAudition(timeSec: number): void {
    this.audition?.seek(timeSec);
  }

  // 試聴中の曲の、一巡の中での経過秒数。試聴していなければ 0。
  public auditionElapsedSec(): number {
    return this.audition?.elapsedSec ?? 0;
  }

  // 指定した曲が一巡する長さ(秒)。一巡という概念を持たない曲では 0。
  public auditionDurationSec(index: number): number {
    const track = BGM_TRACKS[index];
    return track ? trackCycleDurationSec(track) : 0;
  }

  // 設定パネルが閉じた。試聴の線を畳み、ゲーム中の BGM を元へ戻す。
  // 開いた時点で鳴っていなかった場合は伏せて戻すだけなので、無音のままになる。
  public endAudition(): void {
    this.paused = false;
    this.disposeAudition();
    this.ambient?.resume();
    this.syncPump();
  }

  // 試聴の線があれば畳む。
  private disposeAudition(): void {
    this.audition?.dispose(AUDITION_FADE_SEC);
    this.audition = null;
  }
}
