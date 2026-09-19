import { Button, Pulldown } from '../../../hud/widgets';

export type ConstructionMount = 'axial' | 'side+x' | 'side-x' | 'side+y' | 'side-y';

export interface ShipConstructionPanelModel {
  readonly visible: boolean;
  readonly moduleCount: number;
  readonly totalMass: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly capabilitySummary: string;
  readonly role: 'ship' | 'base' | 'material';
  readonly warning: string | null;
  readonly canPlace: boolean;
  readonly canRemove: boolean;
  readonly canFinish: boolean;
}

const MODULE_OPTIONS = [
  ['cockpit-standard', 'コックピット'], ['tank-3-main', '主燃料タンク 3m'],
  ['tank-6-main', '主燃料タンク 6m'], ['tank-12-main', '主燃料タンク 12m'],
  ['tank-3-rcs', 'RCSタンク 3m'], ['tank-6-rcs', 'RCSタンク 6m'],
  ['tank-12-rcs', 'RCSタンク 12m'], ['thruster-standard', '主推進器'],
  ['rcs-standard', 'RCS'], ['weapon-gatling', '機関砲'], ['armor-standard', '装甲'],
  ['radiator-standard', 'ラジエーター'], ['solar-panel-standard', '太陽電池'],
  ['booster-standard', 'ブースター'], ['docking-port-standard', 'ドッキングポート'],
  ['dock-standard', '建造ドック'], ['decoupler-standard', 'デカプラー'],
] as const;

const MOUNT_OPTIONS = [
  ['axial', '軸方向'], ['side+x', '側面 +X'], ['side-x', '側面 −X'],
  ['side+y', '側面 +Y'], ['side-y', '側面 −Y'],
] as const satisfies readonly (readonly [ConstructionMount, string])[];

// 戦闘ビュー左レールの建造セッション表示。状態は ShipConstruction から毎回受け取る。
export class ShipConstructionPanel {
  public get element(): HTMLElement { return this.panel; }
  public onSelectionChange: ((definitionId: string, mount: ConstructionMount) => void) | null = null;
  public onPlace: (() => void) | null = null;
  public onRemove: (() => void) | null = null;
  public onFinish: (() => void) | null = null;
  public onDiscard: (() => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly count: HTMLElement;
  private readonly mass: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly capabilities: HTMLElement;
  private readonly completion: HTMLElement;
  private readonly role: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly place: Button;
  private readonly remove: Button;
  private readonly finish: Button;

  public constructor(els: ReadonlyMap<string, HTMLElement>) {
    this.panel = this.required(els, 'ship-construction-panel');
    this.count = this.required(els, 'construction-count');
    this.mass = this.required(els, 'construction-mass');
    this.hp = this.required(els, 'construction-hp');
    this.capabilities = this.required(els, 'construction-capabilities');
    this.completion = this.required(els, 'construction-completion');
    this.role = this.required(els, 'construction-role');
    this.warning = this.required(els, 'construction-warning');
    const controls = this.required(els, 'construction-controls');
    const selection = new Pulldown(
      '追加部品',
      [
        { items: MODULE_OPTIONS, description: '追加するモジュール' },
        { items: MOUNT_OPTIONS, description: '取り付け位置' },
      ] as const,
      null,
      ([definitionId, mount]) => this.onSelectionChange?.(definitionId, mount),
    );
    controls.appendChild(selection.element);
    const actions = this.required(els, 'construction-actions');
    this.place = new Button('配置', () => this.onPlace?.(), undefined, 'primary');
    this.remove = new Button('末尾撤去', () => this.onRemove?.(), undefined, 'secondary');
    this.finish = new Button('建造終了', () => this.onFinish?.(), undefined, 'primary');
    const discard = new Button('船体破棄', () => this.onDiscard?.(), undefined, 'secondary');
    actions.append(this.place.element, this.remove.element, this.finish.element, discard.element);
    this.sync({
      visible: false, moduleCount: 0, totalMass: 0, hp: 0, maxHp: 0,
      capabilitySummary: '—', role: 'material', warning: null,
      canPlace: false, canRemove: false, canFinish: false,
    });
  }

  public sync(model: ShipConstructionPanelModel): void {
    this.panel.classList.toggle('hidden', !model.visible);
    this.count.textContent = String(model.moduleCount);
    this.mass.textContent = `${Math.round(model.totalMass).toLocaleString()} kg`;
    this.hp.textContent = `${Math.round(model.hp)} / ${Math.round(model.maxHp)}`;
    this.capabilities.textContent = model.capabilitySummary;
    this.completion.textContent = model.canFinish ? '建造終了可能' : '部品を1個以上配置';
    this.role.textContent = model.role === 'ship' ? '船' : model.role === 'base' ? '基地' : '物資';
    this.warning.textContent = model.warning ?? '';
    this.warning.classList.toggle('hidden', model.warning === null);
    this.place.setEnabled(model.canPlace);
    this.remove.setEnabled(model.canRemove);
    this.finish.setEnabled(model.canFinish);
  }

  private required(els: ReadonlyMap<string, HTMLElement>, id: string): HTMLElement {
    const element = els.get(id);
    if (!element) throw new Error(`ShipConstructionPanel: missing HUD element ${id}`);
    return element;
  }
}
