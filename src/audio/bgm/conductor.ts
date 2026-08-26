// 1本の連続した音楽の線。どの曲を鳴らし、いつ次の曲へ送るかを決め、鳴っている曲を
// 先読みで進める。1曲ぶんの発音そのものは TrackPlayback、ユーザー音量と刻みを回す
// タイマーは持ち主(Bgm)の責務。
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

  // destination は持ち主のマスターゲイン。ctx は unlock 済みのものを受け取る。
  // rotates は線ごとの方針で、あとから変わらない — ゲーム中の線は送り、試聴の線は送らない。
  // この線ぶんのゲインをここで組む。曲ごとのフェードとは別の層で、線そのものを伏せるのに使う。
  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly rotates: boolean,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(1, ctx.currentTime);
    this.gain.connect(destination);
  }

  // いま鳴らしている曲。停止したあと同じ曲から再開するために読む。
  get currentTrackIndex(): number {
    return this.trackIdx;
  }

  // 曲を鳴らしている最中か。持ち主が刻みを回す必要があるかの判断に使う。
  get isSounding(): boolean {
    return this.playback !== null;
  }

  // 現在の曲の一巡の中での経過秒数。一巡という概念を持たない曲(antipode)では 0。
  get elapsedSec(): number {
    const duration = trackCycleDurationSec(BGM_TRACKS[this.trackIdx]!);
    if (duration <= 0) return 0;
    const elapsed = this.ctx.currentTime - this.trackStartTime;
    return ((elapsed % duration) + duration) % duration;
  }

  // 曲を開いて刻み始める。trackIdx を省くと無作為に選ぶ。
  start(trackIdx?: number): void {
    if (BGM_TRACKS.length === 0) return;
    const index = trackIdx === undefined
      ? Math.floor(Math.random() * BGM_TRACKS.length)
      : Math.max(0, Math.min(BGM_TRACKS.length - 1, Math.floor(trackIdx)));
    this.openPlayback(index, this.ctx.currentTime + START_DELAY_SEC);
    this.playback?.fadeIn(FADE_IN_SEC);
  }

  // fadeSec 秒かけてフェードアウトする。スケジュール済みの音は曲ごとのゲインを通って
  // 一緒に減衰するので、鳴らし終えるのを待つ必要はない。
  stop(fadeSec: number): void {
    if (!this.playback) return;
    this.playback.fadeOut(fadeSec);
    this.retire(this.playback);
    this.playback = null;
  }

  // この線を畳む。フェードアウトし、鳴り終えたところで自分のゲインごと音声グラフから外す。
  // 以降この線は使えない。
  dispose(fadeSec: number): void {
    const quietAt = this.playback?.soundingUntil ?? this.ctx.currentTime;
    this.stop(fadeSec);
    const waitSec = Math.max(0, quietAt - this.ctx.currentTime);
    setTimeout(() => this.gain.disconnect(), waitSec * 1000);
  }

  // 鳴らしたまま、一巡の中の timeSec 秒の位置へ飛ぶ。
  seek(timeSec: number): void {
    if (!this.playback) return;
    const track = BGM_TRACKS[this.trackIdx]!;
    const atTime = this.ctx.currentTime + START_DELAY_SEC;
    this.playback.seek(stepAtTime(track, timeSec), atTime);
    this.trackStartTime = this.ctx.currentTime - timeSec;
  }

  // この線を無音へ伏せる。刻みは進み続けるので、戻したときは伏せていた間に進んだ位置から聞こえる。
  pause(): void {
    this.gain.gain.setTargetAtTime(DUCK_LEVEL, this.ctx.currentTime, DUCK_FADE_SEC / 3);
  }

  // 伏せた線を元の音量へ戻す。
  resume(): void {
    this.gain.gain.setTargetAtTime(1, this.ctx.currentTime, DUCK_FADE_SEC / 3);
  }

  // deadline より前に始まる音をすべてスケジュールする。曲送りの時刻を過ぎていれば、
  // その前に次の曲へ移る。
  advance(deadline: number): void {
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
    const waitSec = Math.max(0, playback.soundingUntil - this.ctx.currentTime);
    setTimeout(() => playback.dispose(), waitSec * 1000);
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
}
