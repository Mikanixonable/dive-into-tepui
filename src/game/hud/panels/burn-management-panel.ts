// ブースターの段構成・燃焼状態を表示する常設パネル。ゲーム側で作った表示用の
// スナップショットを sync し、操作は setHandlers で注入されたコールバックへ渡す。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { Button } from '../../../hud/widgets';

/** 燃焼管理パネルへ渡す、ゲーム状態から分離された表示モデル。 */
export interface BurnManagementViewModel {
  /** 現在接続されているブースター段数。 */
  readonly stageCount: number;
  /** 接続できる最大段数。未指定なら接続操作の判定をゲーム側へ委ねる。 */
  readonly maxStages?: number;
  /** 接続中の段を含めた総質量(kg)。 */
  readonly totalMass: number;
  /** 最後尾(active)段の現在燃料(kg)。 */
  readonly activeFuel: number;
  /** 最後尾(active)段の最大燃料(kg)。 */
  readonly activeFuelMax: number;
  /** 燃焼状態。UIへそのまま表示できる日本語ラベルでもよい。 */
  readonly burnState: string;
  /** ゲーム側で判定済みの操作可否。省略時は安全な表示側の既定値を使う。 */
  readonly canAttach?: boolean;
  readonly canToggleIgnition?: boolean;
  readonly canDecouple?: boolean;
  /** 点火中なら true。点火ボタンの pressed 表示に使う。 */
  readonly ignitionOn?: boolean;
  /** 状態の aria-label に使う短い説明。 */
  readonly burnStateDescription?: string;
}

interface BurnManagementPanelHandlers {
  readonly onAttach?: () => void;
  readonly onToggleIgnition?: () => void;
  readonly onDecouple?: () => void;
}

interface BurnManagementDom {
  readonly stageCount: HTMLElement;
  readonly totalMass: HTMLElement;
  readonly fuelMeter: HTMLElement;
  readonly fuelFill: HTMLElement;
  readonly fuelValue: HTMLElement;
  readonly burnState: HTMLElement;
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

// 燃焼状態の内部文字列を日本語ラベルへ写す。未知の状態はそのまま返す。
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
  private readonly attachButton: Button;
  private readonly ignitionButton: Button;
  private readonly decoupleButton: Button;
  private handlers: BurnManagementPanelHandlers = {};
  private model: BurnManagementViewModel | null = null;

  // 表示要素を els から取り出し、操作ボタン3種を組み立てる。
  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {
    this.dom = {
      stageCount: this.required('burn-stage-count'),
      totalMass: this.required('burn-total-mass'),
      fuelMeter: this.required('burn-active-fuel-meter'),
      fuelFill: this.required('burn-active-fuel-fill'),
      fuelValue: this.required('burn-active-fuel-value'),
      burnState: this.required('burn-state'),
    };
    this.attachButton = this.addButton(
      'ブースター追加', 'ブースター段を追加する', undefined, () => this.handlers.onAttach?.(),
    );
    this.ignitionButton = this.addButton(
      `点火/停止 [${K.boosterIgnitionToggle.label}]`, 'ブースターの点火/停止を切り替える', K.boosterIgnitionToggle,
      () => this.handlers.onToggleIgnition?.(),
    );
    this.decoupleButton = this.addButton(
      `分離 [${K.boosterDecouple.label}]`, '最後尾のブースター段を分離する', K.boosterDecouple,
      () => this.handlers.onDecouple?.(),
    );
    this.setButtonsEnabled(false, false, false);
  }

  // els から id の要素を取り出す。無ければ HUD の DOM 構成が壊れているので例外にする。
  private required(id: string): HTMLElement {
    const element = this.els.get(id);
    if (!element) throw new Error(`BurnManagementPanel: missing HUD element ${id}`);
    return element;
  }

  // burn-actions プレースホルダへ操作ボタンを1つ足す。key を渡すとキーボードショートカットの
  // aria 属性も付く。
  private addButton(label: string, title: string, key: { label: string } | undefined, onClick: () => void): Button {
    const container = this.els.get('burn-actions');
    if (!container) throw new Error('BurnManagementPanel: missing HUD element burn-actions');
    const button = new Button(label, onClick);
    button.element.title = title;
    button.element.setAttribute('aria-label', key ? `${label}、キー ${key.label}` : label);
    if (key) button.element.setAttribute('aria-keyshortcuts', key.label);
    container.appendChild(button.element);
    return button;
  }

  public setHandlers(handlers: BurnManagementPanelHandlers): void {
    this.handlers = { ...handlers };
  }

  /** 表示モデルを同期する。null はブースターのない機体としてパネルを隠す。 */
  public sync(view: BurnManagementViewModel | null): void {
    this.model = view;
    const panel = this.els.get('burn-management-panel');
    if (!panel) return;
    panel.classList.toggle('hidden', view === null);
    if (!view) {
      this.setButtonsEnabled(false, false, false);
      return;
    }

    const stageCount = Math.max(0, Math.floor(view.stageCount));
    const maxStages = view.maxStages === undefined ? null : Math.max(0, Math.floor(view.maxStages));
    const activeFuel = finiteNonNegative(view.activeFuel);
    const activeFuelMax = finiteNonNegative(view.activeFuelMax);
    const fuelRatio = activeFuelMax > 0 ? Math.min(1, activeFuel / activeFuelMax) : 0;
    const fuelText = formatFuel(activeFuel, activeFuelMax);
    const state = activeFuelMax <= 0 || activeFuel <= 0 ? 'fuel-empty' : view.burnState;

    this.dom.stageCount.textContent = maxStages === null ? `${stageCount} 段` : `${stageCount} / ${maxStages} 段`;
    this.dom.totalMass.textContent = formatMass(view.totalMass);
    this.dom.fuelValue.textContent = fuelText;
    this.dom.fuelFill.style.width = `${(fuelRatio * 100).toFixed(1)}%`;
    this.dom.fuelFill.classList.toggle('danger', fuelRatio <= 0.2);
    this.dom.fuelMeter.setAttribute('aria-valuemin', '0');
    this.dom.fuelMeter.setAttribute('aria-valuemax', String(activeFuelMax));
    this.dom.fuelMeter.setAttribute('aria-valuenow', String(activeFuel));
    this.dom.fuelMeter.setAttribute('aria-valuetext', fuelText);
    this.dom.burnState.textContent = stateLabel(state);
    this.dom.burnState.setAttribute('aria-label', view.burnStateDescription ?? stateLabel(state));

    const noFuel = activeFuelMax <= 0 || activeFuel <= 0;
    const atMax = maxStages !== null && stageCount >= maxStages;
    this.setButtonsEnabled(
      (view.canAttach ?? false) && !atMax,
      (view.canToggleIgnition ?? true) && !noFuel,
      (view.canDecouple ?? true) && stageCount > 0,
    );
    this.ignitionButton.setOn(view.ignitionOn ?? (state === 'igniting' || state === 'burning'));
  }

  // 3操作ボタンの有効/無効を一括で反映する。
  private setButtonsEnabled(attach: boolean, ignition: boolean, decouple: boolean): void {
    this.attachButton.setEnabled(attach);
    this.ignitionButton.setEnabled(ignition);
    this.decoupleButton.setEnabled(decouple);
  }

  public get currentModel(): BurnManagementViewModel | null {
    return this.model;
  }
}
