// 1本の連続した音楽の線。どの曲を鳴らし、いつ次の曲へ送るかを決め、鳴っている曲を
// 先読みで進める。1曲ぶんの発音そのものは TrackPlayback、ユーザー音量と刻みを回す
// タイマーは持ち主(Bgm)の責務。
import { BGM_TRACKS } from './tracks/tracks';
import { createComposer } from './composer-factory';
import { TrackPlayback } from './track-playback';

const START_DELAY_SEC = 0.15; // 再生開始から最初のステップまでの余裕
const FADE_IN_SEC = 4;
const TRACK_ROTATION_SEC = 300; // 1曲を流し続ける長さ

export class Conductor {
  private playback: TrackPlayback | null = null;
  private trackIdx = 0;
  private trackStartTime = 0;
  // 曲送りの対象か。線ごとの方針なので、線が複数になったら構築時に固定する。
  private rotates = true;

  // destination は持ち主のマスターゲイン。ctx は unlock 済みのものを受け取る。
  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode,
  ) {}

  // いま鳴らしている曲。停止したあと同じ曲から再開するために読む。
  get currentTrackIndex(): number {
    return this.trackIdx;
  }

  // 曲を開いて刻み始める。trackIdx を省くと無作為に選ぶ。
  start(trackIdx: number | undefined, rotates: boolean): void {
    if (BGM_TRACKS.length === 0) return;
    const index = trackIdx === undefined
      ? Math.floor(Math.random() * BGM_TRACKS.length)
      : Math.max(0, Math.min(BGM_TRACKS.length - 1, Math.floor(trackIdx)));
    this.rotates = rotates;
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
    this.playback = new TrackPlayback(this.ctx, composer, track.instruments, this.destination, startAt);
  }

  // 同じ曲が連続しないよう、今の曲以外から次の曲を選ぶ。曲が1つしかなければそのまま。
  private nextTrackIndex(): number {
    if (BGM_TRACKS.length <= 1) return this.trackIdx;
    let next = Math.floor(Math.random() * (BGM_TRACKS.length - 1));
    if (next >= this.trackIdx) next++;
    return next;
  }
}
