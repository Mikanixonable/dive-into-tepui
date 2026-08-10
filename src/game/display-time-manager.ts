// マップモードの「未来表示」がいつを指すかの管理: 表示期間の選択、未来ゴーストスライダーの位置、
// および両者から1フレーム分の表示時刻一式(DisplayWindow)を組む窓口。
import * as C from './const';
import { DisplayTimePanel } from './display-time-panel';
import { buildTicks } from './hud/tick-scale';

export type DisplayDurationKey = 'orbit' | 'day' | 'week' | 'month' | 'custom';

// 1フレーム分の「いつを表示しているか」。simTime/referencePeriod から派生する duration/displayTime を
// 呼び出し側ごとに計算し直させないための束。
export interface DisplayWindow {
  readonly simTime: number;
  readonly referencePeriod: number;
  readonly duration: number;
  readonly displayTime: number;
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

export class DisplayTimeManager {
  private _forceCurrent = true;
  private durationKey: DisplayDurationKey = 'orbit';
  private sliderT = 0;
  private customDurationSec = C.DISPLAY_DUR_DAY;
  private predictionRatio = 1;

  private readonly panel: DisplayTimePanel;
  // 直近の sync() で受け取った表示期間 [s]。ジャンプ入力(DOM イベント、フレーム外)が
  // sliderT を逆算する際に参照する。
  private lastDuration = C.APERIODIC_ARC_DURATION;

  // 操作パネルを構築し、期間選択・スライダー・任意期間入力・T+ジャンプ入力の反映先を自身にする。
  constructor(hudRoot: HTMLElement) {
    this.panel = new DisplayTimePanel(hudRoot);
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
    this.panel.onSliderChange = (t) => {
      this.sliderT = t;
    };
    this.panel.onResetToNow = () => {
      this.sliderT = 0;
    };
    this.panel.onJumpToTime = (sec) => {
      this.sliderT = Math.max(0, Math.min(1, sec / this.lastDuration));
    };
  }

  // 未来表示を禁止するフラグ。
  get forceCurrent(): boolean {
    return this._forceCurrent;
  }

  // true にすると未来ゴーストスライダーの位置も原点へ戻す。
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
    if (this.durationKey === 'custom') return this.customDurationSec;
    return FIXED_DURATION_SEC[this.durationKey];
  }

  // simTime/referencePeriod から1フレーム分の表示時刻一式を組む。表示時刻はスライダーが
  // 立っている間だけ未来を指し、forceCurrent または原点では simTime そのもの。
  window(simTime: number, referencePeriod: number): DisplayWindow {
    const duration = this.durationSec(referencePeriod);
    const displayTime = this.forceCurrent || this.sliderT <= 0 ? simTime : simTime + this.sliderT * duration;
    return { simTime, referencePeriod, duration, displayTime };
  }

  // Predictor が実際に到達済みの割合(0..1)。スライダーがまだ積分の届いていない未来を
  // 指しうることをスクラバー上で示すのに使う。
  setPredictionCoverage(ratio: number): void {
    this.predictionRatio = Math.max(0, Math.min(1, ratio));
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スクラバー・目盛り)の表示/非表示と内容を押し出す。
  sync(window: DisplayWindow): void {
    this.lastDuration = window.duration;
    this.panel.render({
      visible: !this.forceCurrent,
      durationKey: this.durationKey,
      customDurationSec: this.customDurationSec,
      duration: window.duration,
      displayTime: window.displayTime,
      sliderSteps: this.sliderSteps(),
      sliderT: this.sliderT,
      predictionRatio: this.predictionRatio,
      ticks: buildTicks(window.duration, TICK_MAX_COUNT),
    });
  }

  // 表示期間を SLIDER_TARGET_STEP_SEC 相当の粒度で刻んだ段階数(上下限あり)。
  private sliderSteps(): number {
    const raw = Math.round(this.lastDuration / SLIDER_TARGET_STEP_SEC);
    return Math.max(SLIDER_MIN_STEPS, Math.min(SLIDER_MAX_STEPS, raw));
  }
}
