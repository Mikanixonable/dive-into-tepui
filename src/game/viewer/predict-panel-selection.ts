// 予測パネルで選ぶ座標系・表示期間・表示時刻・時刻表記を持つ。選択から各方向の表示期間を
// 求め、カメラの基準と現在のビューに合わせる規則を担う。
import type { FrameRotationSource, ReferenceFrame } from '../../physics/frame';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ReferenceFrames } from '../celestial/reference-frames';

const DISPLAY_DUR_DAY = 86400; // 1日 [s]
const DISPLAY_DUR_TEN_DAY = 10 * 86400; // 10日 [s]
const DISPLAY_DUR_MONTH = 30 * 86400; // 1ヶ月 [s]
const DISPLAY_DUR_THREE_MONTH = 90 * 86400; // 3ヶ月 [s]

// 手動レンジで指定できる表示期間の上限 [s](1年)。
export const DISPLAY_DURATION_MAX = 365 * 86400;

// 周期を持たない軌道で、1周期の代わりに表示する期間 [s]。
export const APERIODIC_ARC_DURATION = 86400;

// 表示期間の選択。'orbit' は起点の軌道周期、'custom' は手動レンジ。
export type DisplayDurationKey = 'orbit' | 'day' | 'tenDay' | 'month' | 'threeMonth' | 'custom';

// 過去方向の表示期間の選択。'none' は過去を描かない。
export type DisplayPastDurationKey = 'none' | DisplayDurationKey;

// 目盛りラベルの表記。'absolute' は UTC カレンダー、'relative' は現在からの経過時間。
export type TickLabelMode = 'absolute' | 'relative';

const FIXED_DURATION_SEC: Record<'day' | 'tenDay' | 'month' | 'threeMonth', number> = {
  day: DISPLAY_DUR_DAY,
  tenDay: DISPLAY_DUR_TEN_DAY,
  month: DISPLAY_DUR_MONTH,
  threeMonth: DISPLAY_DUR_THREE_MONTH,
};

// 予測パネルの選択を読む口。
export interface PredictPanelSource {
  // 未来の軌道・マーカーを描く座標系。
  readonly frame: ReferenceFrame;
  // 未来側の表示期間の選択。
  readonly durationKey: DisplayDurationKey;
  // 過去側の表示期間の選択。
  readonly pastDurationKey: DisplayPastDurationKey;
  // 表示期間のうち、現在から表示時刻までの比率。
  readonly sliderT: number;
  // 目盛りと通過時刻の表記。
  readonly tickLabelMode: TickLabelMode;
  // 軌道要素マーカーへ通過時刻を併記するか。
  readonly showElementTimes: boolean;
  // カメラの基準へ描画基準を追随させるか。
  readonly followCamera: boolean;
  // スライダーの目盛りを表示するか。
  readonly showTicks: boolean;
  // referencePeriod に対する未来側の表示期間 [s]。
  durationSec(referencePeriod: number): number;
  // referencePeriod に対する過去側の表示期間 [s]。
  pastDurationSec(referencePeriod: number): number;
}

export class PredictPanelSelection implements PredictPanelSource {
  private _frame: ReferenceFrame;
  private _durationKey: DisplayDurationKey = 'orbit';
  private _customDurationSec = DISPLAY_DUR_DAY;
  private _pastDurationKey: DisplayPastDurationKey = 'none';
  private _customPastDurationSec = DISPLAY_DUR_DAY;
  private _sliderT = 0;
  private _tickLabelMode: TickLabelMode = 'absolute';
  private _showElementTimes = false;
  private _followCamera = true;
  private _showTicks = true;

  // frames は座標系の同一性を保つ生成元、celestialBodies はカメラ追随で選べる天体の索引。
  // cameraFocusId はカメラ追随の初期中心で、登録天体でなければ慣性系から始める。
  public constructor(
    private readonly frames: Pick<ReferenceFrames, 'inertialFrame' | 'frameOf'>,
    private readonly celestialBodies: Pick<CelestialBodies, 'has'>,
    cameraFocusId: string | undefined,
  ) {
    this._frame = frames.inertialFrame;
    this.followCameraFocus(cameraFocusId);
  }

  public get frame(): ReferenceFrame { return this._frame; }
  public get durationKey(): DisplayDurationKey { return this._durationKey; }
  public get pastDurationKey(): DisplayPastDurationKey { return this._pastDurationKey; }
  public get sliderT(): number { return this._sliderT; }
  public get tickLabelMode(): TickLabelMode { return this._tickLabelMode; }
  public get showElementTimes(): boolean { return this._showElementTimes; }
  public get followCamera(): boolean { return this._followCamera; }
  public get showTicks(): boolean { return this._showTicks; }

  // 未来側の表示期間を key へ切り替え、スクラブ位置を現在へ戻す。
  public selectDuration(key: Exclude<DisplayDurationKey, 'custom'>): void {
    this._durationKey = key;
    this._sliderT = 0;
  }

  // 未来側の任意期間を sec にして選び、スクラブ位置を現在へ戻す。
  public selectCustomDuration(sec: number): void {
    this._customDurationSec = sec;
    this._durationKey = 'custom';
    this._sliderT = 0;
  }

  // 過去側の表示期間を key へ切り替える。
  public selectPastDuration(key: Exclude<DisplayPastDurationKey, 'custom'>): void {
    this._pastDurationKey = key;
  }

  // 過去側の任意期間を sec にして選ぶ。
  public selectCustomPastDuration(sec: number): void {
    this._customPastDurationSec = sec;
    this._pastDurationKey = 'custom';
  }

  // スクラブ位置を表示期間に対する比率 t へ移す。
  public setSliderT(t: number): void {
    this._sliderT = t;
  }

  // 表示期間 durationSec の先頭から sec の位置へスクラブ位置を移す。
  public jumpToTime(sec: number, durationSec: number): void {
    this._sliderT = Math.max(0, Math.min(1, sec / durationSec));
  }

  // 時刻ラベルの表記を mode へ切り替える。
  public setTickLabelMode(mode: TickLabelMode): void {
    this._tickLabelMode = mode;
  }

  // 軌道要素マーカーへ通過時刻を併記するかを切り替える。
  public setShowElementTimes(show: boolean): void {
    this._showElementTimes = show;
  }

  // スライダーの目盛りを表示するかを切り替える。
  public setShowTicks(show: boolean): void {
    this._showTicks = show;
  }

  // 未来の軌道・マーカーを描く座標系の中心を id へ差し替える。
  public setFrameCenter(id: string): void {
    this._frame = this.frames.frameOf(id, this._frame.rotatingWith);
  }

  // 未来の軌道・マーカーを描く座標系の回転を rotatingWith へ差し替える。
  public setFrameRotation(rotatingWith: FrameRotationSource | null): void {
    this._frame = this.frames.frameOf(this._frame.center, rotatingWith);
  }

  // カメラの基準へ描画基準を追随させるかを切り替える。
  public setFollowCamera(on: boolean): void {
    this._followCamera = on;
  }

  // カメラの基準が登録天体 id へ移ったとき、描画基準の中心を合わせる。
  public followCameraFocus(id: string | undefined): void {
    if (!this._followCamera || id === undefined || !this.celestialBodies.has(id)) return;
    this._frame = this.frames.frameOf(id, this._frame.rotatingWith);
  }

  // 現在の回転を外し、中心を保った慣性系へ移す。
  public dropRotation(): void {
    this._frame = this.frames.frameOf(this._frame.center, null);
  }

  // referencePeriod に対する未来側の表示期間 [s]。
  public durationSec(referencePeriod: number): number {
    return this.durationFor(this._durationKey, this._customDurationSec, referencePeriod);
  }

  // referencePeriod に対する過去側の表示期間 [s]。
  public pastDurationSec(referencePeriod: number): number {
    if (this._pastDurationKey === 'none') return 0;
    return this.durationFor(this._pastDurationKey, this._customPastDurationSec, referencePeriod);
  }

  // 現在のビューが未来表示を許さない間、スクラブ位置を現在に保つ。
  public followProgress(forceCurrent: boolean): void {
    if (forceCurrent) this._sliderT = 0;
  }

  // 選択 key と参照周期から表示期間 [s] を求める。
  private durationFor(key: DisplayDurationKey, customSec: number, referencePeriod: number): number {
    if (key === 'orbit') {
      return isFinite(referencePeriod) && referencePeriod > 0 ? referencePeriod : APERIODIC_ARC_DURATION;
    }
    if (key === 'custom') return customSec;
    return FIXED_DURATION_SEC[key];
  }
}
