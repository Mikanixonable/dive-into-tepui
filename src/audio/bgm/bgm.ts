// BGM の公開窓口。そのフレームに鳴らすべき BGM の宣言を受け、前の宣言との差を鳴らし分ける。
// 鳴らす線はゲーム中の BGM と試聴の2本で、試聴の期間はゲーム中の BGM を伏せる。
import { BGM_TRACKS } from './tracks/tracks';
import { Conductor } from './conductor';
import type { AudioEngine } from '../audio-engine';
import { trackCycleDurationSec } from './track-cycle';

const PUMP_INTERVAL_MS = 120; // スケジューラを回す間隔
const LOOKAHEAD_SEC = 0.6; // まとめてスケジュールする先読みの幅。タイマーの揺れをこの幅で吸収する
const AUDITION_FADE_SEC = 0.15; // 試聴を切り替える・止めるときのフェード
const RUN_END_FADE_SEC = 2.5; // ランの外へ出たときのフェードアウト

// 保存が無いときのユーザー音量と消音。
export const DEFAULT_BGM_VOLUME = 1;
export const DEFAULT_BGM_MUTED = false;

// 保存された文字列をユーザー音量へ読み直す。数として読めない値は既定へ落とし、読めた値は 0〜1 へ収める。
export function parseBgmVolume(text: string | null): number {
  if (text === null) return DEFAULT_BGM_VOLUME;
  const vol = Number.parseFloat(text);
  if (Number.isNaN(vol)) return DEFAULT_BGM_VOLUME;
  return Math.min(1, Math.max(0, vol));
}

// ユーザー音量を保存文字列へ書き出す。
export function formatBgmVolume(vol: number): string {
  return String(vol);
}

// 保存された文字列を消音の有無へ読み直す。読めない値は既定値へフォールバックする。
export function parseBgmMuted(text: string | null): boolean {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return DEFAULT_BGM_MUTED;
}

// 消音の有無を保存文字列へ書き出す。
export function formatBgmMuted(muted: boolean): string {
  return String(muted);
}

// 曲 index が一巡する長さ(秒)。一巡という概念を持たない曲では 0。
export function auditionDurationSec(index: number): number {
  const track = BGM_TRACKS[index];
  return track ? trackCycleDurationSec(track) : 0;
}

// 試聴している曲。session が変わるたびに曲 track を先頭から鳴らし直し、同じ session のあいだは
// seekId が変わるたびに再生位置を seekSec [s] へ飛ばす。
export interface BgmAudition {
  readonly track: number;
  readonly session: number;
  readonly seekSec: number;
  readonly seekId: number;
}

// そのフレームに鳴らすべき BGM の全体。volume はユーザー音量 [0〜1]、inRun はランが進行中か(ゲーム中の
// BGM を鳴らすか)。audition は試聴の期間の外なら null で、期間の間はゲーム中の BGM を伏せ、試聴している
// 曲を鳴らす(曲を止めていれば 'silent')。
export interface BgmDeclaration {
  readonly volume: number;
  readonly inRun: boolean;
  readonly audition: BgmAudition | 'silent' | null;
}

export class Bgm {
  private masterGain: GainNode | null = null;
  private ambient: Conductor | null = null;
  private audition: Conductor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // 直近に受けた宣言のうち、鳴らし分けに使う値。解禁前に受けた宣言は、解禁できた時点で効く。
  private volume = DEFAULT_BGM_VOLUME;
  private inRun = false;
  private auditioning = false;
  private auditionSession: number | null = null;
  private auditionSeekId: number | null = null;

  // engine が解禁されたら、それまでに受けた宣言どおりに鳴らし始める。
  public constructor(private readonly engine: AudioEngine) {
    engine.whenUnlocked(() => this.syncAmbient());
  }

  // そのフレームに鳴らすべき BGM の全体 declaration を受け、前の宣言との差だけを鳴らし分ける。
  // 同じ宣言を何度渡しても結果は変わらない。
  public sync(declaration: BgmDeclaration): void {
    const { audition } = declaration;
    this.syncVolume(declaration.volume);
    this.syncAuditioning(audition !== null);
    this.syncAudition(audition === 'silent' ? null : audition);
    this.syncRun(declaration.inRun);
  }

  // ユーザー音量を vol へ合わせ、鳴っていれば即反映する。
  private syncVolume(vol: number): void {
    if (vol === this.volume) return;
    this.volume = vol;
    const ctx = this.engine.ctx;
    if (!ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(Math.max(0.0001, vol), ctx.currentTime, 0.1);
  }

  // ユーザー音量を表すマスターゲイン。線を跨いで生き続ける。線を伏せるゲイン・曲のフェードとは
  // 別のノードに持つ — 1つに兼ねると、書き手の違う操作が同じ AudioParam の形を打ち消し合う。
  private ensureMasterGain(ctx: AudioContext): GainNode {
    if (this.masterGain) return this.masterGain;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, this.volume), ctx.currentTime);
    g.connect(ctx.destination);
    this.masterGain = g;
    return g;
  }

  // どれかの線が鳴っていれば刻みを回し、どれも鳴っていなければ止める。
  private syncPump(): void {
    const sounding = (this.ambient?.isSounding ?? false) || (this.audition?.isSounding ?? false);
    if (sounding && !this.timer) {
      this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
    } else if (!sounding && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 先読み時間の範囲まで、動いている線をすべて刻み進める。
  private pump(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const deadline = ctx.currentTime + LOOKAHEAD_SEC;
    this.ambient?.advance(deadline);
    this.audition?.advance(deadline);
  }

  // === ゲーム内BGM (ambient conductor) ===

  // ランが進行中か(= ゲーム内 BGM を鳴らすべきか)を inProgress へ合わせる。
  private syncRun(inProgress: boolean): void {
    if (this.inRun === inProgress) return;
    this.inRun = inProgress;
    this.syncAmbient();
  }

  // 宣言どおりにゲーム内 BGM を鳴らす・畳む。効くのは engine の解禁後から。
  private syncAmbient(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (this.inRun) {
      const line = this.ensureAmbient(ctx);
      if (!line.isSounding) line.start();
    } else {
      this.ambient?.stop(RUN_END_FADE_SEC);
    }
    this.syncPump();
  }

  // ゲーム中の BGM の線。AudioContext ができるまでは組めないので、最初に鳴らすときに作る。
  private ensureAmbient(ctx: AudioContext): Conductor {
    if (!this.ambient) {
      this.ambient = new Conductor(ctx, this.ensureMasterGain(ctx), true);
      if (this.auditioning) this.ambient.pause();
    }
    return this.ambient;
  }

  // === 試聴用 BGM (audition conductor) ===

  // 試聴状態を同期する。試聴開始時はゲーム内 BGM を一時停止し、試聴終了時は試聴音源を解放して
  // 通常 BGM を再開する。
  private syncAuditioning(on: boolean): void {
    if (on === this.auditioning) return;
    this.auditioning = on;
    if (on) {
      this.ambient?.pause();
      return;
    }
    this.disposeAudition();
    this.ambient?.resume();
    this.syncPump();
  }

  // 試聴している曲を audition へ合わせる。止めていれば試聴の線を畳む。
  private syncAudition(audition: BgmAudition | null): void {
    if (audition === null) {
      if (this.audition !== null) {
        this.disposeAudition();
        this.syncPump();
      }
      return;
    }
    // 新しい試聴は先頭から鳴らし直す。解禁前は鳴らせないので、解禁後の宣言で鳴らす。
    if (audition.session !== this.auditionSession) {
      const ctx = this.engine.ctx;
      if (!ctx || BGM_TRACKS.length === 0) return;
      this.disposeAudition();
      this.audition = new Conductor(ctx, this.ensureMasterGain(ctx), false);
      this.audition.start(audition.track);
      this.auditionSession = audition.session;
      this.auditionSeekId = audition.seekId;
      this.syncPump();
      return;
    }
    if (audition.seekId === this.auditionSeekId) return;
    this.auditionSeekId = audition.seekId;
    this.audition?.seek(audition.seekSec);
  }

  // 試聴の線があれば畳む。
  private disposeAudition(): void {
    this.audition?.dispose(AUDITION_FADE_SEC);
    this.audition = null;
    this.auditionSession = null;
    this.auditionSeekId = null;
  }
}
