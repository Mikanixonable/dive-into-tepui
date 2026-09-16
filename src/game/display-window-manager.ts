// マップビューの選択から「未来表示」がどこを・いつを指すかを導出し、操作パネルへ同期する。
//
// ここでいう window は「どの座標系で(frame)・いつを(displayTime)見るか」を1フレーム分に
// 束ねたもので、時間の窓だけを指す語ではない。画面全体で1つに揃っていなければならない —
// 座標系が消費者ごとに違えば同じ画面に並べた線が比較できず、表示時刻が違えばメッシュと
// マーカーが別の瞬間を指す。
import { PredictPanel } from './hud/panels/predict-panel';
import type { PanelCollapse } from './hud/panel-shell';
import { buildTicks } from './hud/orbit/tick-scale';
import { epochUnixSeconds } from '../hud/utils';
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
} from './viewer/predict-panel-selection';
import type { PredictPanelSource, TickLabelMode } from './viewer/predict-panel-selection';
import type { PredictPanelCommands } from './viewer/predict-panel-commands';

// 1フレーム分の「どこを・いつを表示しているか」。
export interface DisplayWindow {
  readonly frame: ReferenceFrame;
  readonly simTime: number;
  readonly referencePeriod: number;
  readonly duration: number;
  // 過去方向の表示期間 [s]。0 なら過去は描かない。duration と対称で、描画区間は
  // [simTime - pastDuration, simTime + duration]。
  readonly pastDuration: number;
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
    historyDuration: Math.max(0, Math.min(DISPLAY_DURATION_MAX, window.pastDuration)),
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

  private readonly panel: PredictPanel;

  private _current: DisplayWindow;

  // 操作パネルを構築し、期間選択・スライダー・任意期間入力・T+ジャンプ入力を命令口へ繋ぐ。
  constructor(
    hudRoot: HTMLElement,
    collapse: PanelCollapse,
    private readonly celestialBodies: CelestialBodies,
    private readonly selection: PredictPanelSource,
    private readonly commands: PredictPanelCommands,
  ) {
    this.epochUnixSec = epochUnixSeconds(celestialBodies.epoch);
    this._current = {
      frame: selection.frame, simTime: 0, referencePeriod: NaN,
      duration: APERIODIC_ARC_DURATION, pastDuration: 0, displayTime: 0, forceCurrent: true,
      tickLabelMode: selection.tickLabelMode, showElementTimes: selection.showElementTimes,
      epochUnixSec: this.epochUnixSec,
    };
    this.panel = new PredictPanel(hudRoot, collapse);
    this.panel.onDurationSelect = (key) => this.commands.selectDuration(key);
    this.panel.onCustomDurationConfirm = (sec) => this.commands.selectCustomDuration(sec);
    this.panel.onPastDurationSelect = (key) => this.commands.selectPastDuration(key);
    this.panel.onPastCustomDurationConfirm = (sec) => this.commands.selectCustomPastDuration(sec);
    this.panel.onTickLabelModeChange = (mode) => this.commands.setTickLabelMode(mode);
    this.panel.onShowElementTimesChange = (show) => this.commands.setShowElementTimes(show);
    this.panel.onShowTicksChange = (show) => this.commands.setShowTicks(show);
    this.panel.onSliderChange = (t) => this.commands.setSliderT(t);
    this.panel.onResetToNow = () => this.commands.setSliderT(0);
    this.panel.onJumpToTime = (sec) => this.commands.jumpToTime(sec, this._current.duration);
  }

  // 軌道フレームが選んでいる役割の公転が成立しなくなったら、慣性系へ落とす。
  dropStaleRotatingFrame(displayTime: number, frameAnchors: FrameAnchorSource): void {
    const rotatingWith = this.selection.frame.rotatingWith;
    if (rotatingWith === null || rotatingWith.kind !== 'revolution') return;
    const role = frameRoleOf(rotatingWith.id);
    if (role === null || frameAnchors.attractorOf(`@${role}`, displayTime) !== null) return;
    this.commands.dropRotation();
  }

  // 直近の resolve() が確定させた表示窓。
  get current(): DisplayWindow {
    return this._current;
  }

  // 選んだ期間の秒数を返す。'orbit' では referencePeriod をそのまま返し、それが有限な正数で
  // なければ APERIODIC_ARC_DURATION へ落とす。どの軌道の周期を参照するかは呼び出し側の文脈で
  // 決まるので、このクラス自身は軌道周期を持たない。
  durationSec(referencePeriod: number): number {
    return this.selection.durationSec(referencePeriod);
  }

  // このフレームの表示窓を確定させて返す。表示時刻はスライダーが立っている間だけ未来を指し、
  // forceCurrent または原点では simTime そのもの。
  resolve(simTime: number, controlled: DynamicEntity | null, forceCurrent: boolean): DisplayWindow {
    const referencePeriod = this.currentOrbitPeriod(controlled, simTime);
    const duration = this.durationSec(referencePeriod);
    const sliderT = this.selection.sliderT;
    this._current = {
      frame: this.selection.frame,
      simTime,
      referencePeriod,
      duration,
      pastDuration: this.selection.pastDurationSec(referencePeriod),
      displayTime: forceCurrent || sliderT <= 0 ? simTime : simTime + sliderT * duration,
      forceCurrent,
      tickLabelMode: this.selection.tickLabelMode,
      showElementTimes: this.selection.showElementTimes,
      epochUnixSec: this.epochUnixSec,
    };
    return this._current;
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スクラバー・目盛り)の表示/非表示と内容を押し出す。
  sync(controlled: DynamicEntity | null): void {
    this.panel.render({
      visible: !this._current.forceCurrent,
      durationKey: this.selection.durationKey,
      pastDurationKey: this.selection.pastDurationKey,
      pastDuration: this._current.pastDuration,
      tickLabelMode: this.selection.tickLabelMode,
      showElementTimes: this.selection.showElementTimes,
      showTicks: this.selection.showTicks,
      duration: this._current.duration,
      displayTime: this._current.displayTime,
      epochUnixSec: this.epochUnixSec,
      sliderSteps: this.sliderSteps(),
      sliderT: this.selection.sliderT,
      predictionRatio: this.predictionCoverageRatio(controlled),
      ticks: buildTicks(this._current.duration, TICK_MAX_COUNT),
    });
  }

  // 操作対象の現在軌道の周期 [s]。対象がいない、または有限な周期が求まらない間は NaN —
  // durationSec 側のフォールバックに委ねる。
  private currentOrbitPeriod(controlled: DynamicEntity | null, simTime: number): number {
    if (!controlled) return NaN;
    const center = strongestAttractor(controlled.motion.state.r, this.celestialBodies.celestialMotions, simTime);
    return controlled.motion.orbitalElementsAround(center, simTime)?.period ?? NaN;
  }

  // 操作対象の予測軌道が表示期間のどこまで届いているかの割合(0..1)。
  private predictionCoverageRatio(controlled: DynamicEntity | null): number {
    const end = controlled?.motion.predicted?.state.t;
    if (end === undefined || this._current.duration <= 0) return 1;
    return Math.max(0, Math.min(1, (end - this._current.simTime) / this._current.duration));
  }

  // 表示期間を SLIDER_TARGET_STEP_SEC 相当の粒度で刻んだ段階数(上下限あり)。
  private sliderSteps(): number {
    const raw = Math.round(this._current.duration / SLIDER_TARGET_STEP_SEC);
    return Math.max(SLIDER_MIN_STEPS, Math.min(SLIDER_MAX_STEPS, raw));
  }

  // 操作パネルの DOM を片付ける。
  dispose(): void {
    this.panel.dispose();
  }
}
