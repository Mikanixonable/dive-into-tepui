// BGM 再生の進行管理。再生トラックの選択・遷移タイミング制御、および先読み発音スケジューリングを行う。
// トラックごとの個別発音処理は TrackPlayback が担当する。
import { BGM_TRACKS } from './tracks/tracks';
import { createComposer } from './composer-factory';
import { TrackPlayback } from './track-playback';
import { stepAtTime, trackCycleDurationSec } from './track-cycle';

const START_DELAY_SEC = 0.15; // 再生開始から最初のステップまでの余裕
const FADE_IN_SEC = 4;
const TRACK_ROTATION_SEC = 300; // 1曲を流し続ける長さ
const DUCK_FADE_SEC = 0.3; // 線を伏せる/戻すときのフェード
const DUCK_LEVEL = 0.0001; // 伏せたときの到達値。指数では 0 へ近づけないため

export class Conductor {
  private readonly gain: GainNode;
  private playback: TrackPlayback | null = null;
  private trackIdx = 0;
  private trackStartTime = 0;

  // destination は出力先ゲインノード。rotates は自動トラック遷移の有無を指定する。
  // 本クラス専用のゲインノードを構成し、トラック別フェードとは独立したダッキング制御を行う。
  public constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly rotates: boolean,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(1, ctx.currentTime);
    this.gain.connect(destination);
  }

  // 現在トラックが再生中かどうかを返す。
  public get isSounding(): boolean {
    return this.playback !== null;
  }

  // 現在トラックの1サイクル内における経過秒数。周回概念を持たないトラック（antipode）では 0。
  public get elapsedSec(): number {
    const duration = trackCycleDurationSec(BGM_TRACKS[this.trackIdx]!);
    if (duration <= 0) return 0;
    const elapsed = this.ctx.currentTime - this.trackStartTime;
    return ((elapsed % duration) + duration) % duration;
  }

  // 曲を開いて刻み始める。trackIdx を省くと無作為に選ぶ。
  public start(trackIdx?: number): void {
    if (BGM_TRACKS.length === 0) return;
    const index = trackIdx === undefined
      ? Math.floor(Math.random() * BGM_TRACKS.length)
      : Math.max(0, Math.min(BGM_TRACKS.length - 1, Math.floor(trackIdx)));
    this.openPlayback(index, this.ctx.currentTime + START_DELAY_SEC);
    this.playback?.fadeIn(FADE_IN_SEC);
  }

  // fadeSec 秒かけてフェードアウトする。スケジュール済みの音は曲ごとのゲインを通って
  // 一緒に減衰するので、鳴らし終えるのを待つ必要はない。
  public stop(fadeSec: number): void {
    if (!this.playback) return;
    this.playback.fadeOut(fadeSec);
    this.retire(this.playback);
    this.playback = null;
  }

  // この線を畳む。フェードアウトし、鳴り終えたところで自分のゲインごと音声グラフから外す。
  // 以降この線は使えない。
  public dispose(fadeSec: number): void {
    const quietAt = this.playback?.soundingUntil ?? this.ctx.currentTime;
    this.stop(fadeSec);
    this.atAudioTime(quietAt, () => this.gain.disconnect());
  }

  // 鳴らしたまま、一巡の中の timeSec 秒の位置へ飛ぶ。
  public seek(timeSec: number): void {
    if (!this.playback) return;
    const track = BGM_TRACKS[this.trackIdx]!;
    const atTime = this.ctx.currentTime + START_DELAY_SEC;
    this.playback.seek(stepAtTime(track, timeSec), atTime);
    this.trackStartTime = this.ctx.currentTime - timeSec;
  }

  // この線を無音へ伏せる。刻みは進み続けるので、戻したときは伏せていた間に進んだ位置から聞こえる。
  public pause(): void {
    this.gain.gain.setTargetAtTime(DUCK_LEVEL, this.ctx.currentTime, DUCK_FADE_SEC / 3);
  }

  // 伏せた線を元の音量へ戻す。
  public resume(): void {
    this.gain.gain.setTargetAtTime(1, this.ctx.currentTime, DUCK_FADE_SEC / 3);
  }

  // deadline より前に始まる音をすべてスケジュールする。曲送りの時刻を過ぎていれば、
  // その前に次の曲へ移る。
  public advance(deadline: number): void {
    // クロスフェードは挟まない。ミニマルミュージックなので、パターンが切り替わるだけでも
    // フェーズの変化として違和感なくアンビエントに馴染む。次の曲は前の曲が刻み終えた
    // 時刻から続けて始めるので、拍が途切れることもない。
    if (this.rotates && this.ctx.currentTime - this.trackStartTime > TRACK_ROTATION_SEC) {
      const startAt = this.playback?.nextStepTime ?? this.ctx.currentTime + START_DELAY_SEC;
      this.openPlayback(this.nextTrackIndex(), startAt);
    }
    this.playback?.scheduleUntil(deadline);
  }

  // 役目を終えた再生を、鳴り終える時刻に切り離す。まだ鳴っているうちに切ると尾が途切れるので、
  // フェードの残りではなく、その再生がスケジュール済みの音が消える時刻まで待つ。
  private retire(playback: TrackPlayback): void {
    this.atAudioTime(playback.soundingUntil, () => playback.dispose());
  }

  // 指定した曲の再生を組み、startAt から刻み始める。前の曲が残っていれば退役させる。
  private openPlayback(index: number, startAt: number): void {
    if (this.playback) this.retire(this.playback);
    this.trackIdx = index;
    this.trackStartTime = this.ctx.currentTime;
    const track = BGM_TRACKS[index]!;
    const composer = createComposer(track);
    this.playback = new TrackPlayback(this.ctx, composer, track.instruments, this.gain, startAt);
  }

  // 同じ曲が連続しないよう、今の曲以外から次の曲を選ぶ。曲が1つしかなければそのまま。
  private nextTrackIndex(): number {
    if (BGM_TRACKS.length <= 1) return this.trackIdx;
    let next = Math.floor(Math.random() * (BGM_TRACKS.length - 1));
    if (next >= this.trackIdx) next++;
    return next;
  }

  // 音声時計の時刻 when に fire を呼ぶ。ctx が止まっているあいだは音と一緒に待ちも止まり、
  // 動き出せば止まった位置から続く。
  private atAudioTime(when: number, fire: () => void): void {
    const timer = this.ctx.createConstantSource();
    timer.offset.value = 0; // 出力は常に 0 の無音の信号。時刻を数える器として繋ぐ
    // 未接続のノードは実装によって ended が発火しないことがあるので、destination まで繋ぐ
    timer.connect(this.ctx.destination);
    timer.onended = () => {
      timer.disconnect();
      fire();
    };
    timer.start();
    timer.stop(when);
  }
}
