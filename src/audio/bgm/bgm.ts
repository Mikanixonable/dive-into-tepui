// BGM の公開窓口。ユーザー音量をマスターゲインとして持ち、音楽の線(Conductor)を束ねて、
// 唯一の先読みタイマーでそれらを進める。どの曲をいつ鳴らすかは線それぞれの責務。
// 線は2本ある: ゲーム中の BGM と、設定画面での試聴。互いのノード鎖は独立していて、
// 試聴はゲーム側の状態に触れない — 設定画面を開いている間ゲーム側は伏せておき、
// 閉じたら試聴の線を畳んでゲーム側を戻す。
// ゲインは3層: マスター(ユーザー音量)、線ごと(その線を伏せる)、曲ごと(その曲のフェード)。
// 1つのノードに兼ねさせると、書き手の違う操作が同じ AudioParam を奪い合い、後の呼び出しが
// 前の形を打ち消すので、層を分けて持つ。
import { BGM_TRACKS } from './tracks/tracks';
import { Conductor } from './conductor';
import { AudioEngine } from '../audio-engine';

const BGM_VOL_KEY = 'tepui.settings.bgm_vol'; // localStorage キー
const PUMP_INTERVAL_MS = 120; // スケジューラを回す間隔
const LOOKAHEAD_SEC = 0.6; // この先ぶんまでまとめてスケジュールし、タイマー精度に依存しないようにする
const AUDITION_FADE_SEC = 0.15; // 試聴を切り替える・止めるときのフェード

export class Bgm {
  private masterGain: GainNode | null = null;
  private ambient: Conductor | null = null;
  private audition: Conductor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private volume = 1;
  private autoStarted = false;

  // 保存済みの音量設定を読み込む。
  constructor(private readonly engine: AudioEngine) {
    try {
      const saved = localStorage.getItem(BGM_VOL_KEY);
      if (saved !== null) this.volume = parseFloat(saved);
    } catch {
      /* localStorage 不可の環境では既定値(ON)のまま */
    }
  }

  getVolume(): number {
    return this.volume;
  }

  // 設定画面からの音量変更。再生中なら即反映し、停止中に正の音量へ上げたら再生を始める。
  setVolume(vol: number): void {
    this.volume = vol;
    try {
      localStorage.setItem(BGM_VOL_KEY, vol.toString());
    } catch {
      /* 保存できなくても再生自体は反映する */
    }
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(Math.max(0.0001, vol), ctx.currentTime, 0.1);
    }
    if (vol > 0) this.start();
  }

  // 起動後最初のユーザー操作(unlock 直後)から呼ばれ、一度だけ再生を始める。
  // 2回目以降と、明示的な再生・停止(playTrack/stop)が先に走っていた場合は何もしない。
  autoStart(): void {
    if (this.autoStarted || !this.engine.ctx) return;
    this.autoStarted = true;
    if (this.volume > 0) this.start();
  }

  // 設定画面が開いた。ゲーム中の BGM を伏せ、試聴だけが聞こえる状態にする。
  beginAudition(): void {
    this.ambient?.pause();
  }

  // 指定した曲を先頭から試聴する。AudioContext の unlock も最初のクリックで行う。
  // 試聴の線は曲送りしないので、選んだ曲がそのまま鳴り続ける。
  playTrack(index: number): void {
    this.engine.unlock();
    // 明示的に曲を選んだ後は、最初の操作での自動開始に上書きさせない
    this.autoStarted = true;
    const ctx = this.engine.ctx;
    if (!ctx || BGM_TRACKS.length === 0) return;
    this.disposeAudition();
    this.audition = new Conductor(ctx, this.ensureMasterGain(ctx), false);
    this.audition.start(index);
    this.syncPump();
  }

  // 試聴を止める。設定画面は開いたままなので、ゲーム中の BGM は伏せたまま。
  stopAudition(): void {
    this.disposeAudition();
    this.syncPump();
  }

  // 設定画面が閉じた。試聴の線を畳み、ゲーム中の BGM を元へ戻す。
  // 開いた時点で鳴っていなかった場合は伏せて戻すだけなので、無音のままになる。
  endAudition(): void {
    this.disposeAudition();
    this.ambient?.resume();
    this.syncPump();
  }

  // ゲーム中の BGM を再開する。直前に鳴らしていた曲から始める。
  resume(): void {
    const ctx = this.engine.ctx;
    if (this.volume <= 0 || !ctx) return;
    this.start(this.ensureAmbient(ctx).currentTrackIndex);
  }

  // ゲーム中の BGM を fadeSec 秒かけてフェードアウトする。
  stop(fadeSec = 2.5): void {
    this.ambient?.stop(fadeSec);
    this.syncPump();
  }

  // ゲーム中の線に曲を開かせる。すでに鳴っていれば何もしない。
  private start(trackIdx?: number): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const line = this.ensureAmbient(ctx);
    if (line.isSounding) return;
    line.start(trackIdx);
    this.syncPump();
  }

  // 試聴の線があれば畳む。
  private disposeAudition(): void {
    this.audition?.dispose(AUDITION_FADE_SEC);
    this.audition = null;
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

  // ゲーム中の BGM の線。AudioContext ができるまでは組めないので、最初に鳴らすときに作る。
  private ensureAmbient(ctx: AudioContext): Conductor {
    if (!this.ambient) this.ambient = new Conductor(ctx, this.ensureMasterGain(ctx), true);
    return this.ambient;
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

  // 先読み時間の範囲まで、動いている線をすべて刻み進める。
  private pump(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const deadline = ctx.currentTime + LOOKAHEAD_SEC;
    this.ambient?.advance(deadline);
    this.audition?.advance(deadline);
  }
}
