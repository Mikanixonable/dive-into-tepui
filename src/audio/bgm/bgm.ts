// BGM の公開窓口。ユーザー音量をマスターゲインとして持ち、音楽の線(Conductor)を束ねて、
// 唯一の先読みタイマーでそれらを進める。どの曲をいつ鳴らすかは線それぞれの責務。
// ゲインは層に分かれる: マスター(音量)と曲ごと(フェード)。混ぜると音量操作とフェードが
// 同じ AudioParam を奪い合うので、別々に保つ。
import { BGM_TRACKS } from './tracks/tracks';
import { Conductor } from './conductor';
import { AudioEngine } from '../audio-engine';

const BGM_VOL_KEY = 'tepui.settings.bgm_vol'; // localStorage キー
const PUMP_INTERVAL_MS = 120; // スケジューラを回す間隔
const LOOKAHEAD_SEC = 0.6; // この先ぶんまでまとめてスケジュールし、タイマー精度に依存しないようにする

export class Bgm {
  private masterGain: GainNode | null = null;
  private ambient: Conductor | null = null;
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

  // 先読みスケジューラが動いているか。stop() 直後のフェードアウト中は false。
  get isRunning(): boolean {
    return this.timer !== null;
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
    if (ctx && this.masterGain && this.timer) {
      this.masterGain.gain.setTargetAtTime(Math.max(0.0001, vol), ctx.currentTime, 0.1);
    } else if (vol > 0 && !this.timer) {
      this.start(undefined, true);
    }
  }

  // 起動後最初のユーザー操作(unlock 直後)から呼ばれ、一度だけ再生を始める。
  // 2回目以降と、明示的な再生・停止(playTrack/stop)が先に走っていた場合は何もしない。
  autoStart(): void {
    if (this.autoStarted || !this.engine.ctx) return;
    this.autoStarted = true;
    if (this.volume > 0) this.start(undefined, true);
  }

  // 指定した曲を先頭から試聴する。AudioContext の unlock も最初のクリックで行う。
  // 試聴は選んだ曲そのものを聴くためのものなので、居座っても曲送りしない。
  playTrack(index: number): void {
    this.engine.unlock();
    // 明示的に曲を選んだ後は、最初の操作での自動開始に上書きさせない
    this.autoStarted = true;
    if (!this.engine.ctx || BGM_TRACKS.length === 0) return;
    this.stop(0.05);
    this.start(index, false);
  }

  // 試聴停止後や、ゲーム中の BGM を再開する。直前に鳴らしていた曲から始める。
  resume(): void {
    const ctx = this.engine.ctx;
    if (this.volume <= 0 || !ctx || this.timer) return;
    this.start(this.ensureAmbient(ctx).currentTrackIndex, true);
  }

  // fadeSec 秒かけてフェードアウトし、刻みを止める。
  stop(fadeSec = 2.5): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ambient?.stop(fadeSec);
  }

  // 線に曲を開かせ、先読みスケジューラを起動する。
  private start(trackIdx: number | undefined, rotates: boolean): void {
    const ctx = this.engine.ctx;
    if (!ctx || this.timer) return;
    this.ensureAmbient(ctx).start(trackIdx, rotates);
    this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  // ゲーム中の BGM の線。AudioContext ができるまでは組めないので、最初に鳴らすときに作る。
  private ensureAmbient(ctx: AudioContext): Conductor {
    if (!this.ambient) this.ambient = new Conductor(ctx, this.ensureMasterGain(ctx));
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

  // 先読み時間の範囲まで、動いている線を刻み進める。
  private pump(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    this.ambient?.advance(ctx.currentTime + LOOKAHEAD_SEC);
  }
}
