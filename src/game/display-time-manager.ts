// マップモードの「未来表示」がいつを指すかの管理: 表示期間(durationKey)・未来ゴーストスライダー
// (sliderT)・その解決(resolveDisplayTime)。forceCurrent は未来表示そのものを禁止するフラグで、
// マップモードの正本(MapModeToggler.mapMode)が切り替える影響先の一つ(初期値 = 戦闘ビューなので
// 禁止)。「何を予測して見せるか」(予測折れ線・ゴーストマーカー・その表示座標系)は PlanDisplay
// (plan/plan-display.ts、PlanEditor 所有)の責務で、ここは「いつを見るか」だけに閉じる。
import * as C from './const';
import { DisplayTimePanel } from './display-time-panel';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

export class DisplayTimeManager {
  // 未来表示を禁止するフラグ。マップモードの正本(MapModeToggler.mapMode)が切り替える
  // 影響先の一つで、視点や編集モードとは独立した責務(初期値 = 戦闘ビューなので禁止)。
  forceCurrent = true;

  durationKey: PredictDurationKey = 'day';
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴースト非表示)。
  sliderT = 0;

  // 表示期間が非連続に変わった瞬間(duration 切替)を、予測折れ線側(PlanDisplay.traj)へ
  // 伝える通知。持ち主が違う(PlanDisplay は PlanEditor 所有)ので、配線は game.ts が行う。
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

  // 選んだ期間だけ予測する(マップモードでの表示用 — 戦闘ビューの噴射ガイド用の期間は
  // plan-guide.ts の guideDurationSec が別途持つ)。'orbit' キーの周期は呼び出し側が渡す
  // (orbitPeriod)ため、player.live を読まない。
  durationSec(orbitPeriod: number | null): number {
    if (this.durationKey === 'orbit') {
      if (orbitPeriod !== null && isFinite(orbitPeriod) && orbitPeriod > 0) return orbitPeriod;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.durationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.durationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  // マップモードの未来ゴーストスライダーが有効な間だけ、環境(太陽・月)表示やマップラベル・
  // 各エンティティの表示位置に使う「未来の」simTime を返す。マップを閉じているか、
  // スライダーが原点にあるときは現在時刻のまま。
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

  // T+ 表記の経過時間ラベル。高度など player.live に依存する情報は PlanDisplay 側の
  // ⬡ ゴーストマーカー自身のラベルが持つ(ここは自分の状態だけで完結させる)。
  private futureTimeLabel(orbitPeriod: number | null): string {
    const tRel = this.sliderT * this.durationSec(orbitPeriod);
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m`;
  }
}
