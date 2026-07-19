// WebAudio による合成効果音(アセット不要)。
// ブラウザの自動再生制限のため、最初のユーザー操作で unlock() を呼ぶこと。
// --- BGM: スティーブ・ライヒ風のアンビエント・ミニマル ---
// 長調でも短調でもない旋法的な音集合(D を中心にした四度堆積/サス系)を、
// 長さの異なる 2 つのパルス・パターン(16 拍と 12 拍)でゆっくり反復する。
// 周期が互いに素なので 2 声のフェイズが少しずつずれていき(ライヒのフェイジング)、
// その上に四度堆積のパッドと低いドローンが漂う。レトロシンセ的な柔らかい
// 波形(sine / triangle)のみで、打楽器は使わない。
// 作曲データ(音階/パターン/パッド/拍長)は複数曲用意し、5分ごとに切り替える
import { BGM_TRACKS, BgmTrack } from './bgm';


const BGM_ENABLED_KEY = 'tepui.settings.bgm'; // localStorage キー

export class Sfx {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private thrustGain: GainNode | null = null;
  private rcsGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmTimer: ReturnType<typeof setInterval> | null = null;
  private bgmNextTime = 0;
  private bgmStep = 0;
  private bgmEnabled = true;
  private currentTrackIdx = 0;
  private bgmTrackStartTime = 0;

  constructor() {
    try {
      const saved = localStorage.getItem(BGM_ENABLED_KEY);
      if (saved !== null) this.bgmEnabled = saved === '1';
    } catch {
      /* localStorage 不可の環境では既定値(ON)のまま */
    }
  }

  isBgmEnabled(): boolean {
    return this.bgmEnabled;
  }

  // 設定画面からの BGM ON/OFF 切替。unlock() 前でも呼べる(値だけ保存し、
  // unlock() 時にそれを見て再生を開始する)。
  setBgmEnabled(on: boolean): void {
    this.bgmEnabled = on;
    try {
      localStorage.setItem(BGM_ENABLED_KEY, on ? '1' : '0');
    } catch {
      /* 保存できなくても再生の ON/OFF 自体は反映する */
    }
    if (on) this.startBgm();
    else this.stopBgm();
  }

  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;

    // 共有ホワイトノイズバッファ
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // スラスタ噴射のループ音(通常は無音)
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.thrustGain = gain;

    // RCS 姿勢制御スラスタの噴射音(メインエンジンより高く軽いシュー音、通常は無音)
    const rcsSrc = ctx.createBufferSource();
    rcsSrc.buffer = buf;
    rcsSrc.loop = true;
    const rcsFilter = ctx.createBiquadFilter();
    rcsFilter.type = 'bandpass';
    rcsFilter.frequency.value = 1600;
    rcsFilter.Q.value = 1.1;
    const rcsG = ctx.createGain();
    rcsG.gain.value = 0;
    rcsSrc.connect(rcsFilter).connect(rcsG).connect(ctx.destination);
    rcsSrc.start();
    this.rcsGain = rcsG;

    if (this.bgmEnabled) this.startBgm();
  }

  // ------------------------------------------------------------------ BGM
  // WebAudio 合成のループ BGM(アセット不要)。ベース + パッド + アルペジオ +
  // ノイズハットを先読みスケジューラで刻む。
  private startBgm(): void {
    if (!this.ctx || this.bgmTimer) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 4); // フェードイン
    g.connect(ctx.destination);
    this.bgmGain = g;
    this.bgmNextTime = ctx.currentTime + 0.15;
    this.bgmTrackStartTime = ctx.currentTime;
    this.currentTrackIdx = Math.floor(Math.random() * BGM_TRACKS.length);
    this.bgmStep = 0;
    this.bgmTimer = setInterval(() => this.pumpBgm(), 120);
  }

  stopBgm(fadeSec = 2.5): void {
    if (this.bgmTimer) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    if (this.ctx && this.bgmGain) {
      this.bgmGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, fadeSec / 3);
    }
  }

  private pumpBgm(): void {
    if (!this.ctx || !this.bgmGain) return;

    // 約5分(300秒)経過したら次の曲へクロスフェードなしでパターンを切り替える
    // (ミニマルミュージックなので、パターンのデータが切り替わるだけでも
    // フェーズの変化として違和感なくアンビエントに馴染む)
    if (this.ctx.currentTime - this.bgmTrackStartTime > 300) {
      // 次の曲をランダムに選ぶ（同じ曲が連続しないようにする）
      let nextIdx = Math.floor(Math.random() * (BGM_TRACKS.length - 1));
      if (nextIdx >= this.currentTrackIdx) nextIdx++;
      this.currentTrackIdx = nextIdx;
      this.bgmTrackStartTime = this.ctx.currentTime;
      this.bgmStep = 0;
    }

    const track = BGM_TRACKS[this.currentTrackIdx]!;

    // 0.6s ぶん先読みしてスケジュール(タイマー精度に依存しない)
    while (this.bgmNextTime < this.ctx.currentTime + 0.6) {
      this.scheduleBgmStep(this.bgmStep, this.bgmNextTime, track);
      this.bgmStep++;
      this.bgmNextTime += track.stepDur;
    }
  }

  private scheduleBgmStep(step: number, t: number, track: BgmTrack): void {
    const g = this.bgmGain!;
    
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
      while (absoluteIdx >= track.scale.length) {
        absoluteIdx -= track.scale.length;
        octShift++;
      }
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

  // 指定時刻に鳴らすトーン(BGM 用。attack を付けてクリックノイズを避ける)
  private toneAt(
    freq: number,
    t: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    dest: AudioNode,
    attack = 0.02,
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }


  private noiseBurst(duration: number, filterType: BiquadFilterType, freq: number, volume: number): void {
    if (!this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  private tone(freq: number, duration: number, volume: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration);
  }

  // 艦砲 CIWS 風の砲声: 低く重い胴鳴り + 鋭いクラック。
  // 実物のように連続音にはせず、1 発ずつ聞こえる離散的な発砲音のまま。
  fire(): void {
    this.noiseBurst(0.11, 'lowpass', 480, 0.4);
    this.noiseBurst(0.025, 'highpass', 2600, 0.09);
    this.tone(48, 0.1, 0.2, 'square');
    this.tone(96, 0.05, 0.07, 'sawtooth');
  }

  // リロード音: 金属質のノイズと金属音を組み合わせて「ガチャッ、シャコォォン」という音を作る
  playReload(): void {
    if (!this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // スライドする金属的なノイズ
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1500, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 1.2);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, t); // 半分に
    gain.gain.exponentialRampToValueAtTime(0.005, t + 1.2);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t, 0, 1.2);

    // バレル排出・交換時の甲高い金属音
    this.tone(1200, 0.1, 0.05, 'square');
    this.tone(800, 0.15, 0.05, 'sawtooth');
    
    // 遅れてもう一度ガチャッという音
    setTimeout(() => {
      this.tone(900, 0.1, 0.04, 'square');
      this.tone(600, 0.15, 0.04, 'sawtooth');
    }, 800);
  }

  // 連射開始前の起動音: 艦砲 CIWS のモーターが立ち上がる唸りに似せる。
  // 低い三角波の唸りが滑り上がり、機械的なこすれノイズが重なる。
  spinUp(): void {
    if (!this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // モーターの唸り(基音 + 3 倍音、周波数が立ち上がる)
    const whine = ctx.createOscillator();
    whine.type = 'triangle';
    whine.frequency.setValueAtTime(50, t);
    whine.frequency.exponentialRampToValueAtTime(205, t + 0.3);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.linearRampToValueAtTime(0.09, t + 0.08);
    wg.gain.setValueAtTime(0.09, t + 0.24);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    whine.connect(wg).connect(ctx.destination);
    whine.start(t);
    whine.stop(t + 0.34);

    const harm = ctx.createOscillator();
    harm.type = 'sawtooth';
    harm.frequency.setValueAtTime(150, t);
    harm.frequency.exponentialRampToValueAtTime(615, t + 0.3);
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.linearRampToValueAtTime(0.022, t + 0.1);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    harm.connect(hg).connect(ctx.destination);
    harm.start(t);
    harm.stop(t + 0.34);

    // 機械のこすれ(バンドパスノイズ、周波数が滑り上がる)
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(1150, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t, Math.random() * 0.4, 0.35);
  }

  // 薬莢が機体に当たったときの、からんとした金属音(かすかに)
  clank(): void {
    if (!this.ctx) return;
    const f0 = 1800 + Math.random() * 1600;
    this.tone(f0, 0.05, 0.035, 'triangle');
    this.tone(f0 * 1.53, 0.04, 0.02, 'triangle'); // 非整数倍音で金属感
    this.noiseBurst(0.03, 'highpass', 5000, 0.02);
  }

  // マガジン給弾(次のマガジンが取り込まれるガチャッという機械音)
  magFeed(): void {
    this.noiseBurst(0.1, 'lowpass', 500, 0.14);
    this.tone(140, 0.07, 0.08, 'square');
    this.noiseBurst(0.05, 'highpass', 3000, 0.04);
  }

  // 補給マガジンの取り込み(肯定的なブリップ)
  pickup(): void {
    this.tone(660, 0.09, 0.09, 'sine');
    this.tone(990, 0.12, 0.07, 'sine');
    this.noiseBurst(0.08, 'lowpass', 600, 0.06);
  }

  // 弾切れの空撃ちクリック
  emptyClick(): void {
    this.tone(1400, 0.03, 0.05, 'square');
    this.noiseBurst(0.02, 'highpass', 4000, 0.03);
  }

  hit(): void {
    this.tone(1500 + Math.random() * 500, 0.08, 0.15, 'triangle');
  }

  explosion(): void {
    // 宇宙での爆発音の代わりに、戦闘システムが検知した撃破通知(ピロっという複数音)
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.toneAt(1200, t, 0.08, 0.08, 'square', this.ctx.destination, 0.01);
    this.toneAt(1500, t + 0.1, 0.08, 0.08, 'square', this.ctx.destination, 0.01);
    this.toneAt(1800, t + 0.2, 0.08, 0.08, 'square', this.ctx.destination, 0.01);
    this.toneAt(2200, t + 0.3, 0.12, 0.08, 'square', this.ctx.destination, 0.01);
  }

  // デブリ衝突音群: 「ことっ」というしょぼい音を複数回。距離(km)に応じて遅延
  debrisImpact(distanceKm: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    
    // 距離に応じた遅れ: 1km = 1s, ±5%の誤差
    const baseDelay = Math.max(0, distanceKm);
    const hits = 2 + Math.floor(Math.random() * 5); // 2〜6回
    
    let currentDelay = baseDelay * (0.95 + Math.random() * 0.1);
    let currentFreq = 350 + Math.random() * 150; // 最初は中音域
    
    for (let i = 0; i < hits; i++) {
      const hitTime = t + currentDelay;
      
      // 「ことっ」という紙コップに物が当たるような音:
      // 少し高めの周波数から一気に落とすことで打撃感を強調。音量も上げる。
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(currentFreq, hitTime);
      osc.frequency.exponentialRampToValueAtTime(currentFreq * 0.2, hitTime + 0.05);
      
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, hitTime);
      gain.gain.linearRampToValueAtTime(0.8, hitTime + 0.005); // 音量を0.15 -> 0.8に増加
      gain.gain.exponentialRampToValueAtTime(0.0001, hitTime + 0.06);
      
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(hitTime);
      osc.stop(hitTime + 0.07);
      
      // 次の破片が当たるまでの時間差
      currentDelay += 0.04 + Math.random() * 0.15;
      // 後の破片ほどエネルギーが低く(音が低く)なる
      currentFreq *= (0.7 + Math.random() * 0.2); 
    }
  }

  warp(): void {
    this.tone(660, 0.06, 0.08, 'sine');
  }

  // 高度低下警報: 短い二音の警告音(熱防御警報よりは緊急度の低いトーン)
  altAlarm(): void {
    this.tone(392, 0.16, 0.09, 'square');
    this.tone(415.3, 0.16, 0.07, 'square'); // わずかに不協和にして警報らしいうなりを出す
  }

  setThrust(on: boolean): void {
    if (!this.ctx || !this.thrustGain) return;
    const target = on ? 0.1 : 0;
    this.thrustGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
  }

  setRcs(on: boolean): void {
    if (!this.ctx || !this.rcsGain) return;
    this.rcsGain.gain.setTargetAtTime(on ? 0.015 : 0, this.ctx.currentTime, 0.03);
  }
}
