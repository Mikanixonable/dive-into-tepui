// マップモードの「未来表示」がいつを指すかの管理: 表示期間(durationKey)・未来ゴーストスライダー
// (sliderT)・その解決(resolveDisplayTime)。
import * as C from './const';
import { DisplayTimePanel } from './display-time-panel';
import { buildTicks } from './hud/tick-scale';
import { SIM_EPOCH_SEC, fmtDateTime, fmtTime } from './hud/utils';

export type DisplayDurationKey = 'orbit' | '90min' | 'day' | 'week' | 'month' | 'manual';

// パネル幅に収まる目盛りの上限本数。
const TICK_MAX_COUNT = 6;

// 固定長プリセットの秒数。キーを増やすと網羅漏れが型エラーになる。
const FIXED_DURATION_SEC: Record<'90min' | 'day' | 'week' | 'month', number> = {
  '90min': C.DISPLAY_DUR_90MIN,
  day: C.DISPLAY_DUR_DAY,
  week: C.DISPLAY_DUR_WEEK,
  month: C.DISPLAY_DUR_MONTH,
};

// スライダーの段階数 [下限, 上限]。期間が長いほど 1 段階あたりの時間が粗くなるので、
// TARGET_STEP_SEC 相当の段階数まで増やす(ただし上限は DOM/イベント負荷を抑えるための天井)。
const SLIDER_MIN_STEPS = 200;
const SLIDER_MAX_STEPS = 4000;
const SLIDER_TARGET_STEP_SEC = 10;

export class DisplayTimeManager {
  private _forceCurrent = true;

  durationKey: DisplayDurationKey = 'orbit';
  // マップモードの未来ゴーストスライダー位置(0..1、0 で現在時刻)。
  sliderT = 0;
  // 'manual' 選択時に使う表示期間 [s]。DISPLAY_DURATION_MAX でクランプする。
  manualDurationSec = C.DISPLAY_DUR_DAY;

  private readonly panel: DisplayTimePanel;
  // 直近の sync で解決した表示期間 [s]。ジャンプ入力(DOM イベント、フレーム外)が
  // sliderT を逆算する際に参照する。
  private lastDurationSec = C.APERIODIC_ARC_DURATION;

  // 操作パネルを構築し、期間選択・スライダー・手動レンジ入力・ジャンプ入力の反映先を自身にする。
  constructor(hudRoot: HTMLElement) {
    this.panel = new DisplayTimePanel(hudRoot);
    // 期間はスライダーの尺度そのものなので、尺度を変えたら位置も原点へ戻す。
    this.panel.onDurationSelect = (key) => {
      this.durationKey = key;
      this.sliderT = 0;
    };
    this.panel.onSliderChange = (t) => {
      this.sliderT = t;
    };
    this.panel.onManualDurationChange = (sec) => {
      this.manualDurationSec = Math.max(C.DISPLAY_DURATION_MIN, Math.min(C.DISPLAY_DURATION_MAX, sec));
    };
    this.panel.onResetToNow = () => {
      this.sliderT = 0;
    };
    this.panel.onJumpToTime = (sec) => {
      this.sliderT = Math.max(0, Math.min(1, sec / this.lastDurationSec));
    };
  }

  // 未来表示を禁止するフラグ。true にすると未来ゴーストスライダーの位置も原点へ戻す。
  get forceCurrent(): boolean {
    return this._forceCurrent;
  }

  set forceCurrent(value: boolean) {
    this._forceCurrent = value;
    if (value) this.sliderT = 0;
  }

  // 選んだ期間の秒数を返す。'orbit' では referencePeriod をそのまま返す — どの軌道の周期を
  // 参照するかは呼び出し側の文脈(計画区間の遷移後軌道、自機の現在軌道など)で決まるため、
  // このクラス自身は軌道周期を持たない。referencePeriod が有限な正数でなければ
  // APERIODIC_ARC_DURATION にフォールバックする。
  durationSec(referencePeriod: number): number {
    if (this.durationKey === 'orbit') {
      return isFinite(referencePeriod) && referencePeriod > 0 ? referencePeriod : C.APERIODIC_ARC_DURATION;
    }
    if (this.durationKey === 'manual') return this.manualDurationSec;
    return FIXED_DURATION_SEC[this.durationKey];
  }

  // スライダーが有効な間は未来の simTime を返す。forceCurrent またはスライダー原点では simTime をそのまま返す。
  resolveDisplayTime(simTime: number, referencePeriod: number): number {
    if (this.forceCurrent || this.sliderT <= 0) return simTime;
    return simTime + this.sliderT * this.durationSec(referencePeriod);
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スライダー・目盛り・手動レンジ・ジャンプ入力)の表示/非表示と
  // 内容を押し出す。
  sync(simTime: number, referencePeriod: number): void {
    this.lastDurationSec = this.durationSec(referencePeriod);
    this.panel.setVisible(!this.forceCurrent);
    this.panel.setDuration(this.durationKey);
    this.panel.setManualVisible(this.durationKey === 'manual');
    this.panel.setManualRange(C.DISPLAY_DURATION_MIN, C.DISPLAY_DURATION_MAX);
    this.panel.setSliderSteps(this.sliderSteps());
    this.panel.setSliderValue(this.sliderT);
    this.panel.setSliderLabel(this.sliderT > 0 ? this.futureTimeLabel(this.sliderT, simTime) : null);
    this.panel.setTicks(buildTicks(this.lastDurationSec, TICK_MAX_COUNT));
  }

  // 表示期間を SLIDER_TARGET_STEP_SEC 相当の粒度で刻んだ段階数(上下限あり)。
  private sliderSteps(): number {
    const raw = Math.round(this.lastDurationSec / SLIDER_TARGET_STEP_SEC);
    return Math.max(SLIDER_MIN_STEPS, Math.min(SLIDER_MAX_STEPS, raw));
  }

  // スライダー位置 t(0..1)が指す絶対日時と T+ 経過時間のラベル。
  private futureTimeLabel(t: number, simTime: number): string {
    const elapsed = t * this.lastDurationSec;
    return `${fmtDateTime(SIM_EPOCH_SEC + simTime + elapsed)} / T+${fmtTime(elapsed)}`;
  }
}
