// BGM の指揮。どの曲をいつ鳴らすか(自動開始・試聴・再開・停止・一定時間での曲送り)を決め、
// ユーザー音量をマスターゲインとして持ち、先読みスケジューラを回して再生中の曲を進める。
// 1曲ぶんの発音そのものは TrackPlayback、どんな音を作るかは Composer の責務。
// ゲインは2層: マスター(音量)と曲ごと(フェード)。混ぜると音量操作とフェードが同じ
// AudioParam を奪い合うので、別々に保つ。
import { BGM_TRACKS } from './bgm-tracks';
import { createComposer } from './create-composer';
import { TrackPlayback } from './track-playback';
import { AudioEngine } from '../audio-engine';

const BGM_VOL_KEY = 'tepui.settings.bgm_vol'; // localStorage キー
const PUMP_INTERVAL_MS = 120; // スケジューラを回す間隔
const LOOKAHEAD_SEC = 0.6; // この先ぶんまでまとめてスケジュールし、タイマー精度に依存しないようにする
const START_DELAY_SEC = 0.15; // 再生開始から最初のステップまでの余裕
const FADE_IN_SEC = 4;
const TRACK_ROTATION_SEC = 300; // 1曲を流し続ける長さ

export class Bgm {
  private masterGain: GainNode | null = null;
  private playback: TrackPlayback | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private volume = 1;
  private trackIdx = 0;
  private trackStartTime = 0;
  private autoStarted = false;
  // 曲送りの対象か。試聴は選んだ曲を鳴らし続けるので、その間だけ false になる。
  private rotates = true;

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

  get isPlaying(): boolean {
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
      this.start();
    }
  }

  // 起動後最初のユーザー操作(unlock 直後)から呼ばれ、一度だけ再生を始める。
  // 2回目以降と、明示的な再生・停止(playTrack/stop)が先に走っていた場合は何もしない。
  autoStart(): void {
    if (this.autoStarted || !this.engine.ctx) return;
    this.autoStarted = true;
    if (this.volume > 0) this.start();
  }

  // 指定した曲を先頭から試聴する。AudioContext の unlock も最初のクリックで行う。
  playTrack(index: number): void {
    this.engine.unlock();
    // 明示的に曲を選んだ後は、最初の操作での自動開始に上書きさせない
    this.autoStarted = true;
    if (!this.engine.ctx || BGM_TRACKS.length === 0) return;
    const safeIndex = Math.max(0, Math.min(BGM_TRACKS.length - 1, Math.floor(index)));
    this.stop(0.05);
    this.start(safeIndex);
    // 試聴は選んだ曲そのものを聴くためのものなので、居座っても曲送りしない。
    this.rotates = false;
  }

  // 試聴停止後や、ゲーム中の BGM を再開する。
  resume(): void {
    if (this.volume <= 0 || !this.engine.ctx || this.timer) return;
    this.start(this.trackIdx);
  }

  // fadeSec 秒かけてフェードアウトし、停止する。スケジュール済みの音は曲ごとのゲインを
  // 通って一緒に減衰するので、鳴らし終えるのを待つ必要はない。
  stop(fadeSec = 2.5): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.playback?.fadeOut(fadeSec);
    this.playback = null;
  }

  // 再生を開始し、先読みスケジューラを起動する。曲は指定が無ければランダムに選ぶ。
  private start(trackIdx?: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || this.timer) return;
    const index = trackIdx === undefined
      ? Math.floor(Math.random() * BGM_TRACKS.length)
      : Math.max(0, Math.min(BGM_TRACKS.length - 1, trackIdx));
    this.rotates = true;
    this.openPlayback(index, ctx, ctx.currentTime + START_DELAY_SEC);
    this.playback?.fadeIn(FADE_IN_SEC);
    this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  // 指定した曲の再生を組み、startAt から刻み始める。
  private openPlayback(index: number, ctx: AudioContext, startAt: number): void {
    this.trackIdx = index;
    this.trackStartTime = ctx.currentTime;
    const composer = createComposer(BGM_TRACKS[index]!);
    this.playback = new TrackPlayback(ctx, composer, this.ensureMasterGain(ctx), startAt);
  }

  // ユーザー音量を表すマスターゲイン。曲を跨いで生き続ける唯一のノード。
  private ensureMasterGain(ctx: AudioContext): GainNode {
    if (this.masterGain) return this.masterGain;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, this.volume), ctx.currentTime);
    g.connect(ctx.destination);
    this.masterGain = g;
    return g;
  }

  // 同じ曲が連続しないよう、今の曲以外から次の曲を選ぶ。曲が1つしかなければそのまま。
  private nextTrackIndex(): number {
    if (BGM_TRACKS.length <= 1) return this.trackIdx;
    let next = Math.floor(Math.random() * (BGM_TRACKS.length - 1));
    if (next >= this.trackIdx) next++;
    return next;
  }

  // 先読み時間の範囲までステップを刻み進める。一定時間おきに曲を切り替える。
  private pump(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;

    // クロスフェードは挟まない。ミニマルミュージックなので、パターンが切り替わるだけでも
    // フェーズの変化として違和感なくアンビエントに馴染む。次の曲は前の曲が刻み終えた
    // 時刻から続けて始めるので、拍が途切れることもない。
    if (this.rotates && ctx.currentTime - this.trackStartTime > TRACK_ROTATION_SEC) {
      const startAt = this.playback?.nextStepTime ?? ctx.currentTime + START_DELAY_SEC;
      this.openPlayback(this.nextTrackIndex(), ctx, startAt);
    }

    this.playback?.scheduleUntil(ctx.currentTime + LOOKAHEAD_SEC);
  }
}
