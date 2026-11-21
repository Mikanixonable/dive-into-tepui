// ブースターの段構成・燃焼状態と、各段の状態を示す常設パネル。
import { Meter } from '../../../hud-kit/widgets';
import { FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO, fuelAlarmLevel } from '../../alarm/alarm-level';
import type { HudEls } from '../hud-els';
import type { PresentationBurnManagement } from '../../presentation-ports';

interface BurnManagementDom {
  readonly stageCount: HTMLElement;
  readonly totalMass: HTMLElement;
  readonly fuelMeter: Meter;
  readonly fuelValue: HTMLElement;
  readonly burnState: HTMLElement;
  readonly moduleList: HTMLElement;
}

// 非有限値・負値を 0 へ丸める。
function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

// 質量(kg)を桁区切り付きの表示文字列にする。
function formatMass(value: number): string {
  return `${Math.round(finiteNonNegative(value)).toLocaleString()} kg`;
}

// 燃料の現在値/最大値(kg)を桁区切り付きの表示文字列にする。
function formatFuel(value: number, max: number): string {
  return `${Math.round(finiteNonNegative(value)).toLocaleString()} / ${Math.round(finiteNonNegative(max)).toLocaleString()} kg`;
}

// 燃焼状態の内部識別子を日本語表示名へマッピングする。未知の状態はそのまま返す。
function stateLabel(state: string): string {
  // 燃料切れは由来の異なる状態名でも同じ表示語に揃える。
  const labels: Record<string, string> = {
    idle: '待機',
    ready: '点火待機',
    igniting: '点火中',
    burning: '燃焼中',
    stopping: '停止中',
    stopped: '停止',
    empty: '燃料切れ',
    'fuel-empty': '燃料切れ',
    separated: '分離済み',
    complete: '燃焼完了',
    connected: '接続中',
    destroyed: '全損',
  };
  return labels[state] ?? state;
}

// 左レールへ配置される燃焼管理パネルの DOM/controller。
export class BurnManagementPanel {
  private readonly dom: BurnManagementDom;

  // 表示要素を els から取り出し、燃料バーを Meter ウィジェットで組み込む。
  public constructor(private readonly els: HudEls) {
    // 燃料警報の境界と表示モデルを同じ Meter に結びつける。
    const fuelMeter = new Meter('最後尾ブースター燃料');
    fuelMeter.setMarks(FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO);
    this.els.get('burn-active-fuel-meter').appendChild(fuelMeter.element);
    this.dom = {
      stageCount: this.els.get('burn-stage-count'),
      totalMass: this.els.get('burn-total-mass'),
      fuelMeter,
      fuelValue: this.els.get('burn-active-fuel-value'),
      burnState: this.els.get('burn-state'),
      moduleList: this.els.get('burn-module-list'),
    };
  }

  // 表示モデルを同期する。null はブースターのない機体としてパネルを隠す。
  public sync(view: PresentationBurnManagement | null): void {
    const panel = this.els.get('burn-management-panel');
    panel.classList.toggle('hidden', view === null);
    if (!view) {
      // 空の表示モデルでは、段一覧も空として扱う。
      this.dom.moduleList.replaceChildren();
      return;
    }

    const stageCount = Math.max(0, Math.floor(view.stageCount));
    const activeFuel = finiteNonNegative(view.activeFuel);
    const activeFuelMax = finiteNonNegative(view.activeFuelMax);
    const fuelText = formatFuel(activeFuel, activeFuelMax);
    // 燃料残量を燃焼状態より優先し、残量がなければ燃料切れを示す。
    const state = activeFuelMax <= 0 || activeFuel <= 0 ? 'fuel-empty' : view.burnState;

    this.dom.stageCount.textContent = `${stageCount} 個`;
    this.dom.totalMass.textContent = formatMass(view.totalMass);
    this.dom.fuelValue.textContent = fuelText;
    this.dom.fuelMeter.setProgress(activeFuel, activeFuelMax, fuelText, fuelAlarmLevel(activeFuel, activeFuelMax));
    this.dom.burnState.textContent = stateLabel(state);
    this.dom.burnState.setAttribute('aria-label', view.burnStateDescription ?? stateLabel(state));

    // 各段は種類と現在状態を対にして表示する。
    const rows = view.modules.map((module) => {
      const row = document.createElement('div');
      row.className = 'row metric';
      const label = document.createElement('span');
      label.className = 'k';
      label.textContent = module.kind === 'booster' ? 'ブースター' : 'デカプラー';
      const value = document.createElement('span');
      value.className = 'v';
      value.textContent = `${module.id}: ${stateLabel(module.state)}`;
      row.append(label, value);
      return row;
    });
    this.dom.moduleList.replaceChildren(...rows);
  }
}
