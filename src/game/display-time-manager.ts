// マップモードの「未来表示」がいつを指すかの管理: 表示期間(durationKey)・未来ゴーストスライダー
// (sliderT)・その解決(resolveDisplayTime)。
import * as C from './const';
import { DisplayTimePanel } from './display-time-panel';
import { fmtTime } from './hud/utils';

export type DisplayDurationKey = '90min' | 'day' | 'week' | 'month' | 'manual';

// スライダー下の目盛りの本数(0..1 を等分する点の数)。
const TICK_COUNT = 6;

export class DisplayTimeManager {
  private _forceCurrent = true;

  durationKey: DisplayDurationKey = 'day';
  // マップモードの未来ゴーストスライダー位置(0..1、0 で現在時刻)。
  sliderT = 0;
  // 'manual' 選択時に使う表示期間 [s]。DISPLAY_DURATION_MAX でクランプする。
  manualDurationSec = C.DISPLAY_DUR_DAY;

  private readonly panel: DisplayTimePanel;

  // 操作パネルを構築し、期間選択・スライダー・手動レンジ入力の反映先を自身にする。
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
  }

  // 未来表示を禁止するフラグ。true にすると未来ゴーストスライダーの位置も原点へ戻す。
  get forceCurrent(): boolean {
    return this._forceCurrent;
  }

  set forceCurrent(value: boolean) {
    this._forceCurrent = value;
    if (value) this.sliderT = 0;
  }

  // 選んだ期間の秒数を返す。
  durationSec(): number {
    if (this.durationKey === '90min') return C.DISPLAY_DUR_90MIN;
    if (this.durationKey === 'week') return C.DISPLAY_DUR_WEEK;
    if (this.durationKey === 'month') return C.DISPLAY_DUR_MONTH;
    if (this.durationKey === 'manual') return this.manualDurationSec;
    return C.DISPLAY_DUR_DAY;
  }

  // スライダーが有効な間は未来の simTime を返す。forceCurrent またはスライダー原点では simTime をそのまま返す。
  resolveDisplayTime(simTime: number): number {
    if (this.forceCurrent || this.sliderT <= 0) return simTime;
    return simTime + this.sliderT * this.durationSec();
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スライダー・目盛り・手動レンジ)の表示/非表示と内容を押し出す。
  sync(): void {
    this.panel.setVisible(!this.forceCurrent);
    this.panel.setDuration(this.durationKey);
    this.panel.setManualVisible(this.durationKey === 'manual');
    this.panel.setManualRange(C.DISPLAY_DURATION_MIN, C.DISPLAY_DURATION_MAX);
    this.panel.setSliderValue(this.sliderT);
    this.panel.setSliderLabel(this.sliderT > 0 ? this.futureTimeLabel(this.sliderT) : null);
    this.panel.setTicks(this.tickLabels());
  }

  // T+ 表記の経過時間ラベル。
  private futureTimeLabel(t: number): string {
    return `T+${fmtTime(t * this.durationSec())}`;
  }

  // スライダー全域を TICK_COUNT 個に等分した各点のラベル。
  private tickLabels(): readonly string[] {
    const labels: string[] = [];
    for (let i = 0; i < TICK_COUNT; i++) labels.push(this.futureTimeLabel(i / (TICK_COUNT - 1)));
    return labels;
  }
}
