// ブースターの段構成・燃焼状態を表示する常設パネル。ゲーム側で作った表示用の
// スナップショットを sync する。操作は各 module のプロパティウィンドウから行う。
import { Meter } from '../../../hud/widgets';
import type { HudEls } from '../hud-els';

/** 燃焼管理パネルへ渡す、ゲーム状態から分離された表示モデル。 */
export interface BurnManagementViewModel {
  /** 現在接続されているブースター段数。 */
  readonly stageCount: number;
  /** 接続中の段を含めた総質量(kg)。 */
  readonly totalMass: number;
  /** booster module 全体の現在燃料(kg)。 */
  readonly activeFuel: number;
  /** booster module 全体の最大燃料(kg)。 */
  readonly activeFuelMax: number;
  /** 燃焼状態。UIへそのまま表示できる日本語ラベルでもよい。 */
  readonly burnState: string;
  /** 点火中なら true。点火ボタンの pressed 表示に使う。 */
  /** 状態の aria-label に使う短い説明。 */
  readonly burnStateDescription?: string;
  readonly modules: readonly {
    readonly id: string;
    readonly kind: 'booster' | 'decoupler';
    readonly state: string;
  }[];
}

// ブースターとデカプラーの操作は各モジュールのプロパティウィンドウから行う。
export type BurnManagementPanelHandlers = Record<string, never>;

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
  };
  return labels[state] ?? state;
}

/** 左レールへ配置される燃焼管理パネルの DOM/controller。 */
export class BurnManagementPanel {
  private readonly dom: BurnManagementDom;
  private model: BurnManagementViewModel | null = null;

  // 表示要素を els から取り出し、燃料バーを Meter ウィジェットで組み込む。
  public constructor(private readonly els: HudEls) {
    const fuelMeter = new Meter('最後尾ブースター燃料');
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

  /** 表示モデルを同期する。null はブースターのない機体としてパネルを隠す。 */
  public sync(view: BurnManagementViewModel | null, _handlers: BurnManagementPanelHandlers = {}): void {
    void _handlers;
    this.model = view;
    const panel = this.els.get('burn-management-panel');
    panel.classList.toggle('hidden', view === null);
    if (!view) {
      this.dom.moduleList.replaceChildren();
      return;
    }

    const stageCount = Math.max(0, Math.floor(view.stageCount));
    const activeFuel = finiteNonNegative(view.activeFuel);
    const activeFuelMax = finiteNonNegative(view.activeFuelMax);
    const fuelRatio = activeFuelMax > 0 ? Math.min(1, activeFuel / activeFuelMax) : 0;
    const fuelText = formatFuel(activeFuel, activeFuelMax);
    const state = activeFuelMax <= 0 || activeFuel <= 0 ? 'fuel-empty' : view.burnState;

    this.dom.stageCount.textContent = `${stageCount} 個`;
    this.dom.totalMass.textContent = formatMass(view.totalMass);
    this.dom.fuelValue.textContent = fuelText;
    this.dom.fuelMeter.setProgress(activeFuel, activeFuelMax, fuelText, fuelRatio <= 0.2);
    this.dom.burnState.textContent = stateLabel(state);
    this.dom.burnState.setAttribute('aria-label', view.burnStateDescription ?? stateLabel(state));

    const rows = view.modules.map((module) => {
      const row = document.createElement('div');
      row.className = 'row metric';
      const label = document.createElement('span');
      label.className = 'k';
      label.textContent = module.kind === 'booster' ? 'ブースター' : 'デカプラー';
      const value = document.createElement('span');
      value.className = 'v';
      value.textContent = `${module.id}: ${module.state}`;
      row.append(label, value);
      return row;
    });
    this.dom.moduleList.replaceChildren(...rows);
  }

  public get currentModel(): BurnManagementViewModel | null {
    return this.model;
  }
}
