// マップモードの「未来表示」がどこを・いつを指すかの管理と、その操作パネル。
//
// ここでいう window は「どの座標系で(frame)・いつを(displayTime)見るか」を1フレーム分に
// 束ねたもので、時間の窓だけを指す語ではない。どちらも画面全体で1つに揃っていなければ
// ならない — 座標系が消費者ごとに違えば同じ画面に並べた線が比較できず、表示時刻が違えば
// メッシュとマーカーが別の瞬間を指す。
import * as C from './const';
import { PredictPanel } from './hud/predict-panel';
import { buildTicks } from './hud/tick-scale';
import type { TickLabelMode } from './hud/calendar-ticks';
import { strongestAttractor } from '../physics/attractor';
import { ReferenceFrame } from '../physics/frame';
import type { Ephemeris } from '../physics/ephemeris';
import type { GameEntity } from './game-entity/game-entity';

export type DisplayDurationKey = 'orbit' | 'day' | 'week' | 'month' | 'custom';

// 過去方向の表示期間の選択。'none'(既定)は過去を描かない。
export type DisplayPastDurationKey = 'none' | DisplayDurationKey;

// 1フレーム分の「どこを・いつを表示しているか」。simTime/referencePeriod から派生する
// duration/displayTime を呼び出し側ごとに計算し直させないための束。
export interface DisplayWindow {
  readonly frame: ReferenceFrame;
  readonly simTime: number;
  readonly referencePeriod: number;
  readonly duration: number;
  // 過去方向の表示期間 [s]。0 なら過去は描かない。duration と対称で、描画区間は
  // [simTime - pastDuration, simTime + duration]。
  readonly pastDuration: number;
  readonly displayTime: number;
  // 時刻ラベルを UTC カレンダーで書くか、simTime からの経過時間で書くか。
  readonly tickLabelMode: TickLabelMode;
}

// パネル幅に収まる目盛りの上限本数。
const TICK_MAX_COUNT = 6;

// 固定長プリセットの秒数。キーを増やすと網羅漏れが型エラーになる。
const FIXED_DURATION_SEC: Record<'day' | 'week' | 'month', number> = {
  day: C.DISPLAY_DUR_DAY,
  week: C.DISPLAY_DUR_WEEK,
  month: C.DISPLAY_DUR_MONTH,
};

// スライダーの段階数 [下限, 上限]。期間が長いほど 1 段階あたりの時間が粗くなるので、
// TARGET_STEP_SEC 相当の段階数まで増やす(ただし上限は DOM/イベント負荷を抑えるための天井)。
const SLIDER_MIN_STEPS = 200;
const SLIDER_MAX_STEPS = 4000;
const SLIDER_TARGET_STEP_SEC = 10;

export class DisplayWindowManager {
  private _forceCurrent = true;
  private durationKey: DisplayDurationKey = 'orbit';
  private pastDurationKey: DisplayPastDurationKey = 'none';
  private sliderT = 0;
  private customDurationSec = C.DISPLAY_DUR_DAY;
  private customPastDurationSec = C.DISPLAY_DUR_DAY;
  private _tickLabelMode: TickLabelMode = 'absolute';
  private _frame: ReferenceFrame;

  private readonly panel: PredictPanel;

  private _current: DisplayWindow;

  // 操作パネルを構築し、期間選択・スライダー・任意期間入力・T+ジャンプ入力の反映先を自身にする。
  constructor(
    hudRoot: HTMLElement,
    private readonly ephemeris: Ephemeris,
  ) {
    this._frame = ephemeris.inertialFrame;
    this._current = {
      frame: this._frame, simTime: 0, referencePeriod: NaN,
      duration: C.APERIODIC_ARC_DURATION, pastDuration: 0, displayTime: 0,
      tickLabelMode: this._tickLabelMode,
    };
    this.panel = new PredictPanel(hudRoot);
    // 期間はスライダーの尺度そのものなので、尺度を変えたら位置も原点へ戻す。
    this.panel.onDurationSelect = (key) => {
      this.durationKey = key;
      this.sliderT = 0;
    };
    this.panel.onCustomDurationConfirm = (sec) => {
      this.customDurationSec = sec;
      this.durationKey = 'custom';
      this.sliderT = 0;
    };
    // 過去期間はスライダーの尺度ではないので、切り替えてもつまみ位置は動かさない。
    this.panel.onPastDurationSelect = (key) => {
      this.pastDurationKey = key;
    };
    this.panel.onPastCustomDurationConfirm = (sec) => {
      this.customPastDurationSec = sec;
      this.pastDurationKey = 'custom';
    };
    this.panel.onTickLabelModeChange = (mode) => {
      this.tickLabelMode = mode;
    };
    this.panel.onSliderChange = (t) => {
      this.sliderT = t;
    };
    this.panel.onResetToNow = () => {
      this.sliderT = 0;
    };
    this.panel.onJumpToTime = (sec) => {
      this.sliderT = Math.max(0, Math.min(1, sec / this._current.duration));
    };
  }

  // 未来の軌道・マーカーを描く座標系。カメラが固定される座標系(MapCamera.cameraFrame)
  // とは独立にプレイヤーが選ぶ。
  get frame(): ReferenceFrame {
    return this._frame;
  }

  set frame(value: ReferenceFrame) {
    if (this._frame === value) return;
    this._frame = value;
  }

  // 時刻ラベルを UTC カレンダーで書くか(既定)、simTime からの経過時間で書くか。
  get tickLabelMode(): TickLabelMode {
    return this._tickLabelMode;
  }

  set tickLabelMode(value: TickLabelMode) {
    if (this._tickLabelMode === value) return;
    this._tickLabelMode = value;
  }

  // 未来表示を禁止するフラグ。true にすると未来ゴーストスライダーの位置も原点へ戻す。
  get forceCurrent(): boolean {
    return this._forceCurrent;
  }

  set forceCurrent(value: boolean) {
    if (this._forceCurrent === value) return;
    this._forceCurrent = value;
    if (value) this.sliderT = 0;
  }

  // 直近の resolve() が確定させた表示窓。
  get current(): DisplayWindow {
    return this._current;
  }

  // 選んだ期間の秒数を返す。'orbit' では referencePeriod をそのまま返す — どの軌道の周期を
  // 参照するかは呼び出し側の文脈(計画区間の遷移後軌道、自機の現在軌道など)で決まるため、
  // このクラス自身は軌道周期を持たない。referencePeriod が有限な正数でなければ
  // APERIODIC_ARC_DURATION にフォールバックする。
  durationSec(referencePeriod: number): number {
    if (this.durationKey === 'orbit') {
      return isFinite(referencePeriod) && referencePeriod > 0 ? referencePeriod : C.APERIODIC_ARC_DURATION;
    }
    if (this.durationKey === 'custom') return this.customDurationSec;
    return FIXED_DURATION_SEC[this.durationKey];
  }

  // 過去方向に遡って描く期間の秒数。durationSec と同じ参照周期の解釈を使い、'none' は 0。
  pastDurationSec(referencePeriod: number): number {
    if (this.pastDurationKey === 'none') return 0;
    if (this.pastDurationKey === 'orbit') {
      return isFinite(referencePeriod) && referencePeriod > 0 ? referencePeriod : C.APERIODIC_ARC_DURATION;
    }
    if (this.pastDurationKey === 'custom') return this.customPastDurationSec;
    return FIXED_DURATION_SEC[this.pastDurationKey];
  }

  // このフレームの表示窓を確定させて返す。表示窓の各値は現在の時刻・操作艦・設定から
  // 軽量に導けるため、直前の結果を条件付きで再利用せず、呼ぶたびに組み直す。_current は
  // update と sync の間、および DOM イベントから直近の窓を読むためのフレームスナップショット
  // であり、導出値のキャッシュではない。表示時刻はスライダーが立っている間だけ未来を指し、
  // forceCurrent または原点では simTime そのもの。
  resolve(simTime: number, player: GameEntity | null): DisplayWindow {
    const referencePeriod = this.currentOrbitPeriod(player, simTime);
    const duration = this.durationSec(referencePeriod);
    this._current = {
      frame: this._frame,
      simTime,
      referencePeriod,
      duration,
      pastDuration: this.pastDurationSec(referencePeriod),
      displayTime: this._forceCurrent || this.sliderT <= 0 ? simTime : simTime + this.sliderT * duration,
      tickLabelMode: this._tickLabelMode,
    };
    return this._current;
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スクラバー・目盛り)の表示/非表示と内容を押し出す。
  sync(player: GameEntity | null): void {
    this.panel.render({
      visible: !this._forceCurrent,
      durationKey: this.durationKey,
      customDurationSec: this.customDurationSec,
      pastDurationKey: this.pastDurationKey,
      customPastDurationSec: this.customPastDurationSec,
      pastDuration: this._current.pastDuration,
      tickLabelMode: this._tickLabelMode,
      duration: this._current.duration,
      displayTime: this._current.displayTime,
      sliderSteps: this.sliderSteps(),
      sliderT: this.sliderT,
      predictionRatio: this.predictionCoverageRatio(player),
      ticks: buildTicks(this._current.duration, TICK_MAX_COUNT),
    });
  }

  // 操作艦・基地の現在軌道の周期 [s]。対象がいない、または有限な周期が求まらない間は NaN —
  // durationSec 側のフォールバックに委ねる。
  private currentOrbitPeriod(player: GameEntity | null, simTime: number): number {
    if (!player) return NaN;
    const center = strongestAttractor(player.state.r, this.ephemeris.attractorsAt(simTime));
    return player.orbitalElementsAround(center)?.period ?? NaN;
  }

  // 操作対象の予測軌道が表示期間のどこまで届いているかの割合(0..1)。
  private predictionCoverageRatio(player: GameEntity | null): number {
    const end = player?.predicted?.state.t;
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
