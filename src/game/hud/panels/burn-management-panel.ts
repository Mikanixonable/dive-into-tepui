// ブースターの段構成・燃焼状態を表示する常設パネル。映す値と操作の口を毎フレーム sync で
// 受け、追加・点火/停止・分離のボタンの操作をその口へ返す。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { Button } from '../../../hud/widgets';

// 燃焼管理パネルが1フレームに映す値。
export interface BurnManagementViewModel {
  readonly stageCount: number;
  // 接続できる最大段数。省略すると段数に上限を示さず、接続の可否も canAttach だけで決まる。
  readonly maxStages?: number;
  // 接続中の段を含めた総質量 [kg]。
  readonly totalMass: number;
  // 最後尾(active)段の現在燃料と最大燃料 [kg]。
  readonly activeFuel: number;
  readonly activeFuelMax: number;
  // 燃焼状態。既知の内部文字列は日本語へ写され、それ以外はそのまま出る。
  readonly burnState: string;
  // 操作可否。省略時はそれぞれの既定値(追加は不可、点火と分離は可)。
  readonly canAttach?: boolean;
  readonly canToggleIgnition?: boolean;
  readonly canDecouple?: boolean;
  // 点火ボタンの点灯。省略すると燃焼状態から決まる。
  readonly ignitionOn?: boolean;
  // 状態の aria-label に使う短い説明。
  readonly burnStateDescription?: string;
}

// 各ボタンの押下を受ける口。
export interface BurnManagementPanelHandlers {
  readonly onAttach?: () => void;
  readonly onToggleIgnition?: () => void;
  readonly onDecouple?: () => void;
}

// 毎フレーム書き換える表示要素。
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

export class BurnManagementPanel {
  private readonly dom: BurnManagementDom;
  private readonly attachButton: Button;
  private readonly ignitionButton: Button;
  private readonly decoupleButton: Button;
  // このフレームに受けた操作の口。ボタンが押されたときに引く。
  private handlers: BurnManagementPanelHandlers = {};

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
    // 追加・点火/停止・分離の3操作。押せるかどうかは sync が毎フレーム決める。
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

  // 映す値と操作の口を同期する。view が null ならブースターのない機体としてパネルを隠す。
  public sync(view: BurnManagementViewModel | null, handlers: BurnManagementPanelHandlers): void {
    this.handlers = handlers;
    const panel = this.els.get('burn-management-panel');
    if (!panel) return;
    panel.classList.toggle('hidden', view === null);
    if (!view) {
      this.setButtonsEnabled(false, false, false);
      return;
    }

    // 表示に使う値を整える。燃料が尽きていれば燃焼状態より燃料切れを優先して出す。
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

    // 上限段数に届いている・燃料が尽きている・段が無いときは、その操作を押せなくする。
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

}
