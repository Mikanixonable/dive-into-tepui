// WebAudio 合成のループ BGM(アセット不要): スティーブ・ライヒ風のアンビエント・ミニマル。
// 長調でも短調でもない旋法的な音集合(D を中心にした四度堆積/サス系)を、
// 長さの異なる 2 つのパルス・パターン(16 拍と 12 拍)でゆっくり反復する。
// 周期が互いに素なので 2 声のフェイズが少しずつずれていき(ライヒのフェイジング)、
// その上に四度堆積のパッドと低いドローンが漂う。レトロシンセ的な柔らかい
// 波形(sine / triangle)のみで、打楽器は使わない。
// 作曲データ(音階/パターン/パッド/拍長)は複数曲用意し、5分ごとに切り替える。
import { BGM_TRACKS, BgmTrack, PhaseCycle, PulseVoice } from './bgm-tracks';
import { AudioEngine } from './audio-engine';

const BGM_VOL_KEY = 'tepui.settings.bgm_vol'; // localStorage キー

// 1スケールステップあたりの半音数の近似(長2度)。音階を引く声部は移調をインデックスの
// 足し引きで表せるが、Hz で直接与えるパッドとドローンは周波数比が要るのでこれで換算する。
const SEMITONES_PER_SCALE_STEP = 2;

// 一定ステップごとに切り替わる循環から、このステップの値を取り出す。
function phaseValue(cycle: PhaseCycle, step: number): number {
  return cycle.values[Math.floor(step / cycle.everySteps) % cycle.values.length]!;
}

// 音階インデックスへ移調とオクターブシフトを適用し、周波数へ解決する。
// 音階の端を越えたぶんはオクターブへ繰り上げ・繰り下げて折り返す。
function scaleFreq(scale: number[], index: number, transpose: number, octave: number): number {
  let absoluteIdx = index + transpose;
  let octShift = octave;
  // 音階の上端を超えたらオクターブを上げて折り返す
  while (absoluteIdx >= scale.length) {
    absoluteIdx -= scale.length;
    octShift++;
  }
  // 下端を下回ったらオクターブを下げて折り返す
  while (absoluteIdx < 0) {
    absoluteIdx += scale.length;
    octShift--;
  }
  return scale[absoluteIdx]! * Math.pow(2, octShift);
}

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
  // 長さの互いに素なパルス2声のポリリズムの上に、移調とオクターブ移動という周期の異なる
  // 2つの循環を重ねるので、曲全体が一巡するまでの長さは各周期の最小公倍数まで伸びる。
  private scheduleStep(step: number, t: number, track: BgmTrack): void {
    const g = this.gain!;
    const transpose = phaseValue(track.transpose, step);
    const octave = phaseValue(track.octave, step);
    // Hz で直接与えるパッドとドローンは、音階を介さないぶんここで周波数比へ換算する。
    const freqRatio = Math.pow(2, (transpose * SEMITONES_PER_SCALE_STEP) / 12) * Math.pow(2, octave);

    this.scheduleVoice(track, track.voiceA, step, t, transpose, octave, g);
    this.scheduleVoice(track, track.voiceB, step, t, transpose, octave, g);

    const pads = track.pads;
    if (step % pads.everySteps === 0) {
      const chord = pads.chords[Math.floor(step / pads.everySteps) % pads.chords.length]!;
      for (const pitch of chord) {
        this.toneAt(pitch * freqRatio, t, track.stepDur * pads.lengthRatio, pads.level, pads.wave, g, pads.attack);
      }
    }

    const drone = track.drone;
    if (step % drone.everySteps === 0) {
      for (const voice of drone.voices) {
        this.toneAt(
          voice.pitch * freqRatio, t, track.stepDur * drone.lengthRatio, voice.level, drone.wave, g, drone.attack,
        );
      }
    }

    const sparkle = track.sparkle;
    if (sparkle !== null && step % sparkle.everySteps === sparkle.atStep) {
      const index = (step * sparkle.indexStride) % track.scale.length;
      const freq = scaleFreq(track.scale, index, transpose, octave + sparkle.octaveOffset);
      this.toneAt(freq, t, sparkle.durationSec, sparkle.level, sparkle.wave, g, sparkle.attack);
      for (const echo of sparkle.echoes) {
        this.toneAt(freq, t + echo.delaySec, sparkle.durationSec, echo.level, sparkle.wave, g, sparkle.attack);
      }
    }
  }

  // パルス声部1つぶんを、倍音を持つならそれも重ねて時刻 t にスケジュールする。
  private scheduleVoice(
    track: BgmTrack, voice: PulseVoice, step: number, t: number, transpose: number, octave: number, dest: AudioNode,
  ): void {
    // パターンは声部ごとに長さが違うので、各々自分の長さで剰余を取って現在の音を選ぶ。
    const index = voice.pattern[step % voice.pattern.length]!;
    const freq = scaleFreq(track.scale, index, transpose, octave);
    const at = t + track.stepDur * voice.stepOffset;
    this.toneAt(freq, at, track.stepDur * voice.lengthRatio, voice.level, voice.wave, dest, voice.attack);
    const harmonic = voice.harmonic;
    if (harmonic !== null) {
      this.toneAt(
        freq * harmonic.ratio, at, track.stepDur * harmonic.lengthRatio, harmonic.level, harmonic.wave, dest,
        voice.attack,
      );
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
