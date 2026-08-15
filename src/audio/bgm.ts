// WebAudio 合成のループ BGM(アセット不要): スティーブ・ライヒ風のアンビエント・ミニマル。
// 長調でも短調でもない旋法的な音集合(D を中心にした四度堆積/サス系)を、
// 長さの異なる 2 つのパルス・パターン(16 拍と 12 拍)でゆっくり反復する。
// 周期が互いに素なので 2 声のフェイズが少しずつずれていき(ライヒのフェイジング)、
// その上に四度堆積のパッドと低いドローンが漂う。レトロシンセ的な柔らかい
// 波形(sine / triangle)のみで、打楽器は使わない。
// 作曲データ(音階/パターン/パッド/拍長)は複数曲用意し、5分ごとに切り替える。
import { BGM_TRACKS, BgmTrack } from './bgm-tracks';
import { AudioEngine } from './audio-engine';

const BGM_VOL_KEY = 'tepui.settings.bgm_vol'; // localStorage キー

export class Bgm {
  private gain: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, this.volume), ctx.currentTime + 4); // フェードイン
    g.connect(ctx.destination);
    this.gain = g;
    this.nextTime = ctx.currentTime + 0.15;
    this.trackStartTime = ctx.currentTime;
    this.trackIdx = trackIdx === undefined
      ? Math.floor(Math.random() * BGM_TRACKS.length)
      : Math.max(0, Math.min(BGM_TRACKS.length - 1, trackIdx));
    this.step = 0;
    this.timer = setInterval(() => this.pump(), 120);
  }

  // 先読み時間の範囲までステップを刻み進める。一定時間おきに曲を切り替える。
  private pump(): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.gain) return;

    // 約5分(300秒)経過したら次の曲へクロスフェードなしでパターンを切り替える
    // (ミニマルミュージックなので、パターンのデータが切り替わるだけでも
    // フェーズの変化として違和感なくアンビエントに馴染む)
    if (ctx.currentTime - this.trackStartTime > 300) {
      // 次の曲をランダムに選ぶ（同じ曲が連続しないようにする）
      let nextIdx = Math.floor(Math.random() * (BGM_TRACKS.length - 1));
      if (nextIdx >= this.trackIdx) nextIdx++;
      this.trackIdx = nextIdx;
      this.trackStartTime = ctx.currentTime;
      this.step = 0;
    }

    const track = BGM_TRACKS[this.trackIdx]!;

    // 0.6s ぶん先読みしてスケジュール(タイマー精度に依存しない)
    while (this.nextTime < ctx.currentTime + 0.6) {
      this.scheduleStep(this.step, this.nextTime, track);
      this.step++;
      this.nextTime += track.stepDur;
    }
  }

  // ステップ番号 step に対応する声部A/B・パッド・ドローン・煌めきの音を時刻 t にスケジュールする。
  private scheduleStep(step: number, t: number, track: BgmTrack): void {
    const g = this.gain!;

    // --- 3階層の入れ子構造による長周期化 (元の周期192ステップの8倍 = 1536ステップで1巡) ---
    // 第1階層(Micro): patA(16) と patB(12) のポリリズム (48ステップ周期)
    // 第2階層(Macro): 192ステップごとにスケールを移調する (4フェーズ)
    const macroCycle = Math.floor(step / 192);
    const macroPhase = macroCycle % 4;
    const transpose = [0, 2, 3, 1][macroPhase]!; // 0, +2, +3, +1 スケールステップ

    // 第3階層(Global): 768ステップ(192*4)ごとに全体の音域(オクターブ)を変化させる (2フェーズ)
    const globalCycle = Math.floor(step / 768);
    const globalPhase = globalCycle % 2;
    const octaveShift = globalPhase === 1 ? 1 : 0; // 後半は1オクターブ上がる

    // 指定した音階インデックスから、移調とオクターブシフトを適用した周波数を計算
    const getFreq = (idx: number, trans: number, oct: number) => {
      let absoluteIdx = idx + trans;
      let octShift = oct;
      // 音階の上端を超えたらオクターブを上げて折り返す
      while (absoluteIdx >= track.scale.length) {
        absoluteIdx -= track.scale.length;
        octShift++;
      }
      // 下端を下回ったらオクターブを下げて折り返す
      while (absoluteIdx < 0) {
        absoluteIdx += track.scale.length;
        octShift--;
      }
      return track.scale[absoluteIdx]! * Math.pow(2, octShift);
    };

    // 移調幅のおおよその周波数比 (パッドやドローンの絶対周波数シフト用)
    // 1スケールステップ = 約2半音(長2度)として近似
    const freqRatio = Math.pow(2, (transpose * 2) / 12) * Math.pow(2, octaveShift);

    // 声部 A: 16 拍パターンの柔らかいパルス
    const fa = getFreq(track.patA[step % track.patA.length]!, transpose, octaveShift);
    this.toneAt(fa, t, track.stepDur * 1.3, 0.03, track.toneA1, g, 0.015);
    this.toneAt(fa * 2.003, t, track.stepDur * 0.7, 0.009, track.toneA2, g, 0.015); // わずかにデチューンした倍音

    // 声部 B: 12 拍パターンを半拍ずらして重ねる
    const fb = getFreq(track.patB[step % track.patB.length]!, transpose, octaveShift);
    this.toneAt(fb, t + track.stepDur / 2, track.stepDur * 1.1, 0.022, track.toneB, g, 0.02);

    // パッド: 四度堆積の和音が約 13 秒ごとにゆっくり移ろう
    if (step % 32 === 0) {
      for (const f of track.pads[((step / 32) | 0) % track.pads.length]!) {
        this.toneAt(f * freqRatio, t, track.stepDur * 34, 0.013, 'triangle', g, 4.5);
      }
    }

    // ドローン: 深い D のうなり
    if (step % 64 === 0) {
      this.toneAt(track.drone[0]! * freqRatio, t, track.stepDur * 66, 0.02, 'sine', g, 6);
      this.toneAt(track.drone[1]! * freqRatio, t, track.stepDur * 66, 0.012, 'sine', g, 6);
    }

    // ときおり高音の煌めき + 減衰エコー
    if (step % 8 === 5) {
      const fs = getFreq((step * 5) % track.scale.length, transpose, octaveShift + 2); // 基本より2オクターブ上
      this.toneAt(fs, t, 0.5, 0.011, 'sine', g, 0.01);
      this.toneAt(fs, t + 0.63, 0.5, 0.005, 'sine', g, 0.01);
      this.toneAt(fs, t + 1.26, 0.5, 0.0025, 'sine', g, 0.01);
    }
  }

  // 指定時刻に鳴らすトーン(attack を付けてクリックノイズを避ける)
  private toneAt(
    freq: number,
    t: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    dest: AudioNode,
    attack = 0.02,
  ): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    // 立ち上がり~減衰のゲイン包絡を組む
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }
}
