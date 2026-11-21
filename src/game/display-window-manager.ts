// マップ表示の座標系・表示時刻・期間をフレームごとの表示窓として確定する。
import { DisplayTimelinePanel } from './hud/panels/display-timeline-panel';
import type { PanelCollapse } from './hud/panel-chrome';
import type { OverlayManager } from '../hud-kit/overlay-manager';
import { buildTicks } from './hud/orbit/tick-scale';
import { epochUnixSeconds } from '../hud-kit/format';
import type { TimeLabelSetting } from './hud/orbit/calendar-ticks';
import { strongestAttractor } from '../physics/attractor';
import { frameRoleOf } from '../physics/frame';
import type { FrameAnchorSource, ReferenceFrame } from '../physics/frame';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { PredictedArc } from './dynamic/predicted-arc';
import type { TrajectoryDemand } from './dynamic/trajectory-demand';
import type { CelestialBodies } from './celestial/celestial-bodies';
import {
  APERIODIC_ARC_DURATION, DISPLAY_DURATION_MAX,
} from './viewer/display-timeline-selection';
import type { DisplayTimelineSource, TickLabelMode } from './viewer/display-timeline-selection';
import type { DisplayTimelineCommands } from './viewer/display-timeline-commands';

// 1フレーム分の「どこを・いつを表示しているか」。
export interface DisplayWindow {
  readonly frame: ReferenceFrame;
  readonly simTime: number;
  readonly referencePeriod: number;
  // 表示期間 [s]。過去側・未来側は同じ値を使い、描画区間は [simTime - duration, simTime + duration]。
  readonly duration: number;
  readonly displayTime: number;
  // 未来表示を禁止しているか。禁止中は displayTime が simTime に固定される。
  readonly forceCurrent: boolean;
  // 時刻ラベルを UTC カレンダーで書くか、simTime からの経過時間で書くか。
  readonly tickLabelMode: TickLabelMode;
  // 軌道要素マーカー(近地点/遠地点・昇交点/降交点・再接近点など)へ通過時刻を併記するか。
  readonly showElementTimes: boolean;
  // このランの元期(simTime=0 が指す絶対時刻)の unix 秒相当。simTime を足すとその瞬間の
  // 表示用 unix 秒になる。日時ラベルを書く側はこれを経由する。
  readonly epochUnixSec: number;
}

// 通過時刻ラベルの設定を、その表示窓から組む唯一の入口。
export function timeLabelSettingOf(window: DisplayWindow): TimeLabelSetting {
  return {
    mode: window.tickLabelMode,
    show: window.showElementTimes,
    nowSimTime: window.simTime,
    epochUnixSec: window.epochUnixSec,
  };
}

// 表示窓と、そのフレームに表示している計画の弧から、進行へ渡す需要を組む唯一の入口。
// 履歴の長さは、手動レンジと同じ上限(DISPLAY_DURATION_MAX)へ収めて渡す。
export function trajectoryDemandOf(
  window: DisplayWindow, planArcs: readonly PredictedArc[],
): TrajectoryDemand {
  return {
    horizon: window.duration,
    historyDuration: Math.max(0, Math.min(DISPLAY_DURATION_MAX, window.duration)),
    planArcs,
  };
}

// パネル幅に収まる目盛りの上限本数。
const TICK_MAX_COUNT = 6;

// スライダーの段階数 [下限, 上限] と、1 段階あたりの目安の粗さ [s]。上限は DOM/イベント負荷の天井。
const SLIDER_MIN_STEPS = 200;
const SLIDER_MAX_STEPS = 4000;
const SLIDER_TARGET_STEP_SEC = 10;

export class DisplayWindowManager {
  // このランの元期の unix 秒相当。
  private readonly epochUnixSec: number;

  private readonly panel: DisplayTimelinePanel;

  private _current: DisplayWindow;

  // 操作パネルを構築し、期間選択・スライダー・任意期間入力・T+ジャンプ入力を命令口へ繋ぐ。
  public constructor(
    hudRoot: HTMLElement,
    collapse: PanelCollapse,
    overlayManager: OverlayManager,
    private readonly celestialBodies: CelestialBodies,
    private readonly selection: DisplayTimelineSource,
    private readonly commands: DisplayTimelineCommands,
  ) {
    this.epochUnixSec = epochUnixSeconds(celestialBodies.epoch);
    // 起動時の窓は現在時刻に合わせる。
    this._current = {
      frame: selection.frame, simTime: 0, referencePeriod: NaN,
      duration: APERIODIC_ARC_DURATION, displayTime: 0, forceCurrent: true,
      tickLabelMode: selection.tickLabelMode, showElementTimes: selection.showElementTimes,
      epochUnixSec: this.epochUnixSec,
    };
    this.panel = new DisplayTimelinePanel(hudRoot, collapse, overlayManager);
    // パネル操作を次の進行へ適用する命令へ結ぶ。
    this.panel.onDurationSelect = (key) => this.commands.selectDuration(key);
    this.panel.onCustomDurationConfirm = (sec) => this.commands.selectCustomDuration(sec);
    this.panel.onTickLabelModeChange = (mode) => this.commands.setTickLabelMode(mode);
    this.panel.onShowElementTimesChange = (show) => this.commands.setShowElementTimes(show);
    this.panel.onShowTicksChange = (show) => this.commands.setShowTicks(show);
    this.panel.onSliderChange = (t) => this.commands.setSliderT(t);
    this.panel.onResetToNow = () => this.commands.setSliderT(0.5);
    this.panel.onJumpToTime = (sec) => this.commands.jumpToTime(sec, this._current.duration);
  }

  // 軌道フレームが選んでいる役割の公転が成立しなくなったら、慣性系へ落とす。
  public dropStaleRotatingFrame(displayTime: number, frameAnchors: FrameAnchorSource): void {
    const rotatingWith = this.selection.frame.rotatingWith;
    if (rotatingWith === null || rotatingWith.kind !== 'revolution') return;
    const role = frameRoleOf(rotatingWith.id);
    if (role === null || frameAnchors.attractorOf(`@${role}`, displayTime) !== null) return;
    this.commands.dropRotation();
  }

  // 直近の resolve() が確定させた表示窓。
  public get current(): DisplayWindow {
    return this._current;
  }

  // 建造など未来表示を一時停止するモードが、現在の表示窓を保ったまま強制現在表示を切り替える。
  public setForceCurrent(forceCurrent: boolean): void {
    this._current = { ...this._current, forceCurrent,
      displayTime: forceCurrent ? this._current.simTime : this._current.displayTime };
  }

  // 選んだ期間の秒数を返す。'orbit' では referencePeriod をそのまま返し、それが有限な正数で
  // なければ APERIODIC_ARC_DURATION へ落とす。どの軌道の周期を参照するかは呼び出し側の文脈で
  // 決まるので、このクラス自身は軌道周期を持たない。
  public durationSec(referencePeriod: number): number {
    return this.selection.durationSec(referencePeriod);
  }

  // このフレームの表示窓を確定させて返す。表示時刻はスライダーが立っている間は
  // 時間軸上の過去または未来を指し、forceCurrent では simTime そのもの。
  public resolve(simTime: number, controlled: DynamicEntity | null, forceCurrent: boolean): DisplayWindow {
    // 対象の軌道に基づく期間とスクラブ位置から、このフレームの窓を確定する。
    const referencePeriod = this.currentOrbitPeriod(controlled, simTime);
    const duration = this.durationSec(referencePeriod);
    const sliderT = this.selection.sliderT;
    this._current = {
      frame: this.selection.frame,
      simTime,
      referencePeriod,
      duration,
      displayTime: forceCurrent ? simTime : simTime + (sliderT * 2 - 1) * duration,
      forceCurrent,
      tickLabelMode: this.selection.tickLabelMode,
      showElementTimes: this.selection.showElementTimes,
      epochUnixSec: this.epochUnixSec,
    };
    return this._current;
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スクラバー・目盛り)の表示/非表示と内容を押し出す。
  public sync(controlled: DynamicEntity | null): void {
    // 選択状態と予測の到達範囲を操作パネルへ渡す。
    this.panel.render({
      visible: !this._current.forceCurrent,
      durationKey: this.selection.durationKey,
      tickLabelMode: this.selection.tickLabelMode,
      showElementTimes: this.selection.showElementTimes,
      showTicks: this.selection.showTicks,
      duration: this._current.duration,
      displayTime: this._current.displayTime,
      epochUnixSec: this.epochUnixSec,
      sliderSteps: this.sliderSteps(),
      sliderT: this.selection.sliderT,
      predictionRatio: this.predictionCoverageRatio(controlled),
      ticks: buildTicks(2 * this._current.duration, TICK_MAX_COUNT),
    });
  }

  // 操作対象の現在軌道の周期 [s]。対象がいない、または有限な周期が求まらない間は NaN —
  // durationSec 側のフォールバックに委ねる。
  private currentOrbitPeriod(controlled: DynamicEntity | null, simTime: number): number {
    if (!controlled) return NaN;
    const center = strongestAttractor(controlled.motion.state.r, this.celestialBodies.celestialMotions, simTime);
    return controlled.motion.orbitalElementsAround(center, simTime)?.period ?? NaN;
  }

  // 操作対象の予測軌道が、時間軸全域のうち未来側のどこまで届いているかの位置(0.5..1)。
  // 時間軸 [T−D, T+D] の 0.5 が現在時刻なので、予測が届く先は軸上の 0.5 + ratio/2。
  private predictionCoverageRatio(controlled: DynamicEntity | null): number {
    const end = controlled?.motion.predicted?.state.t;
    if (end === undefined || this._current.duration <= 0) return 1;
    const ratio = Math.max(0, Math.min(1, (end - this._current.simTime) / this._current.duration));
    return 0.5 + ratio / 2;
  }

  // 時間軸全域(2×表示期間)を SLIDER_TARGET_STEP_SEC 相当の粒度で刻んだ段階数(上下限あり)。
  private sliderSteps(): number {
    const raw = Math.round(2 * this._current.duration / SLIDER_TARGET_STEP_SEC);
    return Math.max(SLIDER_MIN_STEPS, Math.min(SLIDER_MAX_STEPS, raw));
  }

  // 操作パネルの DOM を片付ける。
  public dispose(): void {
    this.panel.dispose();
  }
}
