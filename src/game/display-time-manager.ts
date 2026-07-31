// マップモードの「未来表示」がいつを指すかの管理: 表示期間(durationKey)・未来ゴーストスライダー
// (sliderT)・その解決(resolveDisplayTime)。
import * as C from './const';
import { DisplayTimePanel } from './display-time-panel';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

export class DisplayTimeManager {
  // 未来表示を禁止するフラグ(初期値 true = 戦闘ビューでは禁止)。
  forceCurrent = true;

  durationKey: PredictDurationKey = 'day';
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴースト非表示)。
  sliderT = 0;

  // 表示期間の非連続な切替を通知するコールバック。
  onDurationChange: (() => void) | null = null;

  private readonly panel: DisplayTimePanel;

  constructor(hudRoot: HTMLElement) {
    this.panel = new DisplayTimePanel(hudRoot);
    this.panel.onDurationSelect = (key) => {
      this.durationKey = key;
      this.onDurationChange?.();
    };
    this.panel.onSliderChange = (t) => {
      this.sliderT = t;
    };
  }

  // 選んだ期間の秒数を返す。'orbit' キーの周期は orbitPeriod で渡す。
  durationSec(orbitPeriod: number | null): number {
    if (this.durationKey === 'orbit') {
      if (orbitPeriod !== null && isFinite(orbitPeriod) && orbitPeriod > 0) return orbitPeriod;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.durationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.durationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  // スライダーが有効な間は未来の simTime を返す。forceCurrent またはスライダー原点では simTime をそのまま返す。
  resolveDisplayTime(orbitPeriod: number | null, simTime: number): number {
    if (this.forceCurrent || this.sliderT <= 0) return simTime;
    return simTime + this.sliderT * this.durationSec(orbitPeriod);
  }

  // 毎フレーム呼ぶ。操作パネル(期間・スライダー)の表示/非表示と内容を押し出す。
  sync(orbitPeriod: number | null): void {
    this.panel.setVisible(!this.forceCurrent);
    this.panel.setDuration(this.durationKey);
    this.panel.setSliderLabel(this.sliderT > 0 ? this.futureTimeLabel(orbitPeriod) : null);
  }

  // T+ 表記の経過時間ラベル。
  private futureTimeLabel(orbitPeriod: number | null): string {
    const tRel = this.sliderT * this.durationSec(orbitPeriod);
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m`;
  }
}
