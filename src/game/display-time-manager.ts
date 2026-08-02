// マップモードの「未来表示」がいつを指すかの管理: 表示期間(durationKey)・未来ゴーストスライダー
// (sliderT)・その解決(resolveDisplayTime)。
import * as C from './const';
import { DisplayTimePanel } from './display-time-panel';
import { fmtTime } from './hud/utils';

export type DisplayDurationKey = 'orbit' | 'day' | 'week' | 'month' | 'manual';

// スライダー下の目盛りの本数(0..1 を等分する点の数)。
const TICK_COUNT = 6;

export class DisplayTimeManager {
  // 未来表示を禁止するフラグ(初期値 true = 戦闘ビューでは禁止)。
  forceCurrent = true;

  durationKey: DisplayDurationKey = 'day';
  // マップモードの未来ゴーストスライダー位置(0..1、0 で現在時刻)。
  sliderT = 0;
  // 'manual' 選択時に使う表示期間 [s]。DISPLAY_DURATION_MAX でクランプする。
  manualDurationSec = C.DISPLAY_DUR_DAY;

  private readonly panel: DisplayTimePanel;

  // 操作パネルを構築し、期間選択・スライダー・手動レンジ入力の反映先を自身にする。
  constructor(hudRoot: HTMLElement) {
    this.panel = new DisplayTimePanel(hudRoot);
    this.panel.onDurationSelect = (key) => {
      this.durationKey = key;
    };
    this.panel.onSliderChange = (t) => {
      this.sliderT = t;
    };
    this.panel.onManualDurationChange = (sec) => {
      this.manualDurationSec = Math.max(0, Math.min(C.DISPLAY_DURATION_MAX, sec));
    };
  }

  // 選んだ期間の秒数を返す。'orbit' キーの周期は orbitPeriod で渡す。
  durationSec(orbitPeriod: number | null): number {
    if (this.durationKey === 'orbit') {
      if (orbitPeriod !== null && isFinite(orbitPeriod) && orbitPeriod > 0) return orbitPeriod;
      return C.DISPLAY_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.durationKey === 'week') return C.DISPLAY_DUR_WEEK;
    if (this.durationKey === 'month') return C.DISPLAY_DUR_MONTH;
    if (this.durationKey === 'manual') return this.manualDurationSec;
    return C.DISPLAY_DUR_DAY;
  }

  // スライダーが有効な間は未来の simTime を返す。forceCurrent またはスライダー原点では simTime をそのまま返す。
  resolveDisplayTime(orbitPeriod: number | null, simTime: number): number {
    if (this.forceCurrent || this.sliderT <= 0) return simTime;
    return simTime + this.sliderT * this.durationSec(orbitPeriod);
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スライダー・目盛り・手動レンジ)の表示/非表示と内容を押し出す。
  sync(orbitPeriod: number | null): void {
    this.panel.setVisible(!this.forceCurrent);
    this.panel.setDuration(this.durationKey);
    this.panel.setManualVisible(this.durationKey === 'manual');
    this.panel.setSliderLabel(this.sliderT > 0 ? this.futureTimeLabel(this.sliderT, orbitPeriod) : null);
    this.panel.setTicks(this.tickLabels(orbitPeriod));
  }

  // T+ 表記の経過時間ラベル。
  private futureTimeLabel(t: number, orbitPeriod: number | null): string {
    return `T+${fmtTime(t * this.durationSec(orbitPeriod))}`;
  }

  // スライダー全域を TICK_COUNT 個に等分した各点のラベル。
  private tickLabels(orbitPeriod: number | null): readonly string[] {
    const labels: string[] = [];
    for (let i = 0; i < TICK_COUNT; i++) labels.push(this.futureTimeLabel(i / (TICK_COUNT - 1), orbitPeriod));
    return labels;
  }
}
