// BGM の再生制御。音量とその保存、フェードイン/アウト、曲の切替と試聴、先読みスケジューラの
// 駆動、そして Composer が作った音を WebAudio へ流すところまでを持つ。
// どんな音を作るかは Composer の責務で、このクラスは中身を知らない。
import { BGM_TRACKS } from './bgm-tracks';
import { Composer, ComposerNote } from './composer';
import { PhasingComposer } from './phasing-composer';
import { AudioEngine } from '../audio-engine';

const BGM_VOL_KEY = 'tepui.settings.bgm_vol'; // localStorage キー
const PUMP_INTERVAL_MS = 120; // スケジューラを回す間隔
const LOOKAHEAD_SEC = 0.6; // この先ぶんまでまとめてスケジュールし、タイマー精度に依存しないようにする
const START_DELAY_SEC = 0.15; // 再生開始から最初のステップまでの余裕
const FADE_IN_SEC = 4;
const TRACK_ROTATION_SEC = 300; // 1曲を流し続ける長さ

export class Bgm {
  private gain: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private composer: Composer | null = null;
  private nextTime = 0;
  private step = 0;
  private volume = 1;
  private trackIdx = 0;
  private trackStartTime = 0;
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
    if (ctx && this.gain && this.timer) {
      this.gain.gain.setTargetAtTime(Math.max(0.0001, vol), ctx.currentTime, 0.1);
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
  }

  // 試聴停止後や、ゲーム中の BGM を再開する。
  resume(): void {
    if (this.volume <= 0 || !this.engine.ctx || this.timer) return;
    this.start(this.trackIdx);
  }

  // fadeSec 秒かけてフェードアウトし、停止する。
  stop(fadeSec = 2.5): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.engine.ctx;
    if (ctx && this.gain) {
      this.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, fadeSec / 3);
    }
  }

  // 再生を開始し、先読みスケジューラを起動する。曲は指定が無ければランダムに選ぶ。
  private start(trackIdx?: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || this.timer) return;
    // マスターゲインをフェードインさせながら生成する
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, this.volume), ctx.currentTime + FADE_IN_SEC);
    g.connect(ctx.destination);
    this.gain = g;
    this.nextTime = ctx.currentTime + START_DELAY_SEC;
    this.selectTrack(
      trackIdx === undefined
        ? Math.floor(Math.random() * BGM_TRACKS.length)
        : Math.max(0, Math.min(BGM_TRACKS.length - 1, trackIdx)),
      ctx,
    );
    this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  // 指定した曲の Composer を組み、ステップを先頭へ戻す。
  private selectTrack(index: number, ctx: AudioContext): void {
    this.trackIdx = index;
    this.composer = new PhasingComposer(BGM_TRACKS[index]!);
    this.trackStartTime = ctx.currentTime;
    this.step = 0;
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
    if (!ctx || !this.gain) return;

    // クロスフェードは挟まない。ミニマルミュージックなので、パターンが切り替わるだけでも
    // フェーズの変化として違和感なくアンビエントに馴染む。
    if (ctx.currentTime - this.trackStartTime > TRACK_ROTATION_SEC) {
      this.selectTrack(this.nextTrackIndex(), ctx);
    }

    const composer = this.composer;
    if (!composer) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_SEC) {
      for (const note of composer.notesAt(this.step)) this.playNote(note, this.nextTime);
      this.step++;
      this.nextTime += composer.stepDurSec;
    }
  }

  // 1音を、ステップ開始時刻 stepTime を基準にスケジュールする。
  private playNote(note: ComposerNote, stepTime: number): void {
    const ctx = this.engine.ctx;
    const dest = this.gain;
    if (!ctx || !dest) return;
    const t = stepTime + note.offsetSec;
    const osc = ctx.createOscillator();
    osc.type = note.wave;
    osc.frequency.value = note.freq;
    // 立ち上がり~減衰のゲイン包絡を組み、クリックノイズを避ける
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(note.level, t + note.attackSec);
    gain.gain.exponentialRampToValueAtTime(0.001, t + note.durationSec);
    osc.connect(gain).connect(dest);
    osc.start(t);
    osc.stop(t + note.durationSec + 0.05);
  }
}
