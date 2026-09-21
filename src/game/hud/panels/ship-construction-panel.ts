import { SHIP_MODULE_CATALOG } from '../../ship/ship-module-catalog';
import type { ShipModuleCategory, ShipModuleDefinition } from '../../ship/ship-module-definition';
import type { ConstructionRole, ShipConstructionPanelModel } from '../../ship/ship-construction-types';
import { Button, Meter, TabBar } from '../../../hud/widgets';

const CATEGORY_ITEMS: readonly (readonly [ShipModuleCategory, string])[] = [
  ['command', '指令'], ['fuel', '燃料'], ['propulsion', '推進'], ['combat', '戦闘'], ['utility', '設備'],
];

const CATEGORY_BY_KIND: Readonly<Record<ShipModuleDefinition['kind'], ShipModuleCategory>> = {
  cockpit: 'command', dock: 'command', docking_port: 'utility', tank: 'fuel', booster: 'propulsion',
  thruster: 'propulsion', rcs: 'propulsion', weapon: 'combat', armor: 'combat', radiator: 'utility',
  solar_panel: 'utility', decoupler: 'utility',
};

const DEFAULT_CAPABILITIES = { thrust: 0, mainFuel: 0, rcsFuel: 0, power: 0, radiation: 0 };

interface CapabilityElements {
  readonly thrust: HTMLElement;
  readonly mainFuel: HTMLElement;
  readonly rcsFuel: HTMLElement;
  readonly power: HTMLElement;
  readonly radiation: HTMLElement;
}

// 建造セッションのスナップショットを、部品選択・候補選択・結果確認へ分けて表示するパネル。
export class ShipConstructionPanel {
  public get element(): HTMLElement { return this.panel; }
  public onSelectionChange: ((definitionId: string) => void) | null = null;
  public onSlotChange: ((slotId: string) => void) | null = null;
  public onPlace: (() => void) | null = null;
  public onRemove: (() => void) | null = null;
  public onFinish: (() => void) | null = null;
  public onDiscard: (() => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly shipName: HTMLElement;
  private readonly dockName: HTMLElement;
  private readonly count: HTMLElement;
  private readonly mass: HTMLElement;
  private readonly massPreview: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly hpMeter: Meter;
  private readonly hpPreview: HTMLElement;
  private readonly capabilities: CapabilityElements;
  private readonly role: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly selectedModule: HTMLElement;
  private readonly selectedSlot: HTMLElement;
  private readonly completion: HTMLElement;
  private readonly categoryRoot: HTMLElement;
  private readonly moduleCards: HTMLElement;
  private readonly slotList: HTMLElement;
  private readonly categoryTabs: TabBar<ShipModuleCategory>;
  private readonly place: Button;
  private readonly remove: Button;
  private readonly finish: Button;
  private readonly discard: Button;
  private readonly definitions: readonly ShipModuleDefinition[] = SHIP_MODULE_CATALOG.all();
  private activeCategory: ShipModuleCategory = 'command';
  private moduleSignature = '';
  private slotSignature = '';
  private readonly moduleButtons = new Map<string, Button>();
  private readonly slotButtons = new Map<string, Button>();

  // 静的な器へ既存Widgetを差し込み、動的なカタログ/候補の再構築点を固定する。
  public constructor(els: ReadonlyMap<string, HTMLElement>) {
    this.panel = this.required(els, 'ship-construction-panel');
    this.shipName = this.required(els, 'construction-ship-name');
    this.dockName = this.required(els, 'construction-dock-name');
    this.count = this.required(els, 'construction-count');
    this.mass = this.required(els, 'construction-mass');
    this.massPreview = this.required(els, 'construction-mass-preview');
    this.hp = this.required(els, 'construction-hp');
    this.hpPreview = this.required(els, 'construction-hp-preview');
    this.capabilities = {
      thrust: this.required(els, 'construction-thrust'),
      mainFuel: this.required(els, 'construction-main-fuel'),
      rcsFuel: this.required(els, 'construction-rcs-fuel'),
      power: this.required(els, 'construction-power'),
      radiation: this.required(els, 'construction-radiation'),
    };
    this.role = this.required(els, 'construction-role');
    this.warning = this.required(els, 'construction-warning');
    this.selectedModule = this.required(els, 'construction-selected-module');
    this.selectedSlot = this.required(els, 'construction-selected-slot');
    this.completion = this.required(els, 'construction-completion');
    this.categoryRoot = this.required(els, 'construction-category-tabs');
    this.moduleCards = this.required(els, 'construction-module-cards');
    this.slotList = this.required(els, 'construction-slots');
    this.hpMeter = new Meter();
    this.hpMeter.element.classList.add('construction-hp-meter');
    this.required(els, 'construction-hp-meter').appendChild(this.hpMeter.element);

    this.categoryTabs = new TabBar(CATEGORY_ITEMS, (category) => {
      this.activeCategory = category;
      this.moduleSignature = '';
      this.renderModules('');
    });
    this.categoryTabs.element.classList.add('construction-category-tabs');
    this.categoryRoot.appendChild(this.categoryTabs.element);

    const actions = this.required(els, 'construction-actions');
    this.place = new Button('配置', () => this.onPlace?.(), undefined, 'primary');
    this.remove = new Button('末尾撤去', () => this.onRemove?.(), undefined, 'secondary');
    this.finish = new Button('建造終了', () => this.onFinish?.(), undefined, 'primary');
    this.discard = new Button('船体破棄', () => this.onDiscard?.(), undefined, 'secondary');
    const destructive = document.createElement('div');
    destructive.className = 'construction-destructive-actions';
    destructive.appendChild(this.discard.element);
    actions.append(this.place.element, this.remove.element, this.finish.element, destructive);
    this.sync(hiddenModel());
  }

  // 毎フレームのsnapshotを、数値・候補・操作可能状態へ分解してDOMへ同期する。
  public sync(model: ShipConstructionPanelModel): void {
    this.panel.classList.toggle('hidden', !model.visible);
    this.shipName.textContent = model.shipName;
    this.dockName.textContent = model.dockLabel;
    this.count.textContent = String(model.moduleCount);
    this.mass.textContent = `${format(model.totalMass)} kg`;
    this.massPreview.textContent = model.preview === null ? '' : `配置後 ${format(model.preview.mass)} kg`;
    this.hp.textContent = `${format(model.hp)} / ${format(model.maxHp)}`;
    this.hpPreview.textContent = model.preview === null ? '' : `配置後 最大HP ${format(model.preview.maxHp)}`;
    this.hpMeter.setRatio(model.maxHp > 0 ? model.hp / model.maxHp : 0);
    this.hpMeter.setDanger(model.maxHp > 0 && model.hp / model.maxHp < 0.3);
    this.hpMeter.setLabel(`${format(model.hp)} / ${format(model.maxHp)}`);
    this.capabilities.thrust.textContent = capabilityText(model.capabilities.thrust, model.preview?.capabilities.thrust);
    this.capabilities.mainFuel.textContent = capabilityText(model.capabilities.mainFuel, model.preview?.capabilities.mainFuel);
    this.capabilities.rcsFuel.textContent = capabilityText(model.capabilities.rcsFuel, model.preview?.capabilities.rcsFuel);
    this.capabilities.power.textContent = capabilityText(model.capabilities.power, model.preview?.capabilities.power);
    this.capabilities.radiation.textContent = capabilityText(model.capabilities.radiation, model.preview?.capabilities.radiation);
    this.role.textContent = roleLabel(model.role);
    this.role.dataset['role'] = model.role;
    this.warning.textContent = model.warning ?? '';
    this.warning.classList.toggle('hidden', model.warning === null);
    this.selectedModule.textContent = model.selectedModuleName;
    this.selectedSlot.textContent = model.slots.find(slot => slot.id === model.selectedSlotId)?.label ?? '候補なし';
    this.completion.textContent = model.canFinish ? '建造終了可能' : '部品を1個以上配置';
    this.categoryTabs.setSelected(this.activeCategory);
    this.renderModules(model.selectedDefinitionId);
    this.renderSlots(model);
    this.place.setEnabled(model.canPlace);
    this.remove.setEnabled(model.canRemove);
    this.finish.setEnabled(model.canFinish);
    this.discard.setEnabled(model.visible);
  }

  // カテゴリが変わったときだけカードを組み直し、毎フレームのselection変更ではDOMを壊さない。
  private renderModules(selectedId: string): void {
    const definitions = this.definitions.filter(definition => moduleCategory(definition) === this.activeCategory);
    const signature = `${this.activeCategory}:${definitions.map(definition => definition.id).join(',')}`;
    if (signature !== this.moduleSignature) {
      this.moduleCards.replaceChildren();
      this.moduleButtons.clear();
      for (const definition of definitions) {
        const card = document.createElement('div');
        card.className = 'construction-module-card';
        const button = new Button(
          moduleButtonLabel(definition), () => this.onSelectionChange?.(definition.id), undefined, 'secondary',
        );
        button.element.title = moduleDescription(definition);
        card.appendChild(button.element);
        this.moduleCards.appendChild(card);
        this.moduleButtons.set(definition.id, button);
      }
      this.moduleSignature = signature;
    }
    for (const [id, button] of this.moduleButtons) button.setOn(id === selectedId);
  }

  // 候補一覧に変更があった場合のみボタンを再生成し、選択状態は毎フレーム反映する。
  private renderSlots(model: ShipConstructionPanelModel): void {
    const signature = model.slots.map(slot => `${slot.id}:${slot.valid}:${slot.reason ?? ''}`).join('|');
    if (signature !== this.slotSignature) {
      this.slotList.replaceChildren();
      this.slotButtons.clear();
      for (const slot of model.slots) {
        const button = new Button(slot.label, () => this.onSlotChange?.(slot.id), undefined, 'dense');
        button.element.classList.add('construction-slot-button');
        button.element.dataset['valid'] = String(slot.valid);
        button.element.title = slot.reason ?? 'このスロットを選択';
        this.slotList.appendChild(button.element);
        this.slotButtons.set(slot.id, button);
      }
      this.slotSignature = signature;
    }
    for (const slot of model.slots) {
      const button = this.slotButtons.get(slot.id);
      if (button === undefined) continue;
      button.setOn(slot.id === model.selectedSlotId);
      button.element.dataset['valid'] = String(slot.valid);
    }
  }

  // HUDの静的DOM契約を、null参照ではなく組み立て時の診断へ変換する。
  private required(els: ReadonlyMap<string, HTMLElement>, id: string): HTMLElement {
    const element = els.get(id);
    if (!element) throw new Error(`ShipConstructionPanel: missing HUD element ${id}`);
    return element;
  }
}

// コンストラクタ直後とモード終了時に使う、表示資源を持たないsnapshot。
function hiddenModel(): ShipConstructionPanelModel {
  return {
    visible: false, shipName: '—', dockLabel: '—', moduleCount: 0, totalMass: 0, hp: 0, maxHp: 0,
    capabilities: DEFAULT_CAPABILITIES, preview: null, role: 'material', warning: null,
    selectedDefinitionId: 'cockpit-standard', selectedModuleName: 'コックピット', selectedSlotId: 'axial',
    slots: [], canPlace: false, canRemove: false, canFinish: false,
  };
}

// 旧形式の定義データにも表示カテゴリを適用できるよう、kind から既定カテゴリを導出する。
function moduleCategory(definition: ShipModuleDefinition): ShipModuleCategory {
  return definition.category ?? CATEGORY_BY_KIND[definition.kind];
}

// カードの主ラベルは、選択時に比較しやすい名称・寸法・質量へ固定する。
function moduleButtonLabel(definition: ShipModuleDefinition): string {
  return `${definition.name}  ${format(definition.length)}m / ${format(definition.dryMass)}kg`;
}

// ホバー/読み上げ用に、部品が持つ主要能力だけを短い説明へまとめる。
function moduleDescription(definition: ShipModuleDefinition): string {
  const abilities = definition.abilities;
  const values: string[] = [];
  if (abilities.thrust !== undefined) values.push(`推力 ${format(abilities.thrust)}N`);
  if (abilities.fuelCapacity !== undefined) values.push(`容量 ${format(abilities.fuelCapacity)}`);
  if (abilities.powerGeneration !== undefined) values.push(`発電 ${format(abilities.powerGeneration)}W`);
  if (abilities.radiationArea !== undefined) values.push(`放熱 ${format(abilities.radiationArea)}m²`);
  return values.length === 0 ? definition.name : values.join(' / ');
}

// 現在値と配置後の値を同じ行で読めるよう、変化があるときだけ後値を添える。
function capabilityText(value: number, preview?: number): string {
  const base = format(value);
  if (preview === undefined) return base;
  return preview === value ? base : `${base}  (配置後 ${format(preview)})`;
}

// role の内部語彙をUIの短い日本語ラベルへ変換する。
function roleLabel(role: ConstructionRole): string {
  return role === 'ship' ? '船' : role === 'base' ? '基地' : '物資';
}

// 全ての建造数値の丸めと桁区切りを一箇所へ寄せる。
function format(value: number): string {
  return Math.round(value).toLocaleString();
}
