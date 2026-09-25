import { SHIP_MODULE_CATALOG } from '../../ship/ship-module-catalog';
import type { ShipModuleCategory, ShipModuleDefinition } from '../../ship/ship-module-definition';
import type { ConstructionRole, ShipConstructionPanelModel } from '../../ship/ship-construction-types';
import { Button, Meter, TabBar } from '../../../hud/widgets';
import type { HudEls, HudElId } from '../hud-els';

const CATEGORY_ITEMS: readonly (readonly [ShipModuleCategory, string])[] = [
  ['command', '指令'], ['fuel', '燃料'], ['propulsion', '推進'], ['combat', '戦闘'], ['utility', '設備'],
];

const CATEGORY_BY_KIND: Readonly<Record<ShipModuleDefinition['kind'], ShipModuleCategory>> = {
  cockpit: 'command', dock: 'command', docking_port: 'utility', tank: 'fuel', booster: 'propulsion',
  thruster: 'propulsion', rcs: 'propulsion', weapon: 'combat', armor: 'combat', radiator: 'utility',
  solar_panel: 'utility', decoupler: 'utility',
};

const DEFAULT_CAPABILITIES = { thrust: 0, mainFuel: 0, rcsFuel: 0, power: 0, radiation: 0 };

interface MetricPair {
  readonly value: HTMLElement;
  readonly preview: HTMLElement;
}

interface CapabilityElements {
  readonly thrust: MetricPair;
  readonly mainFuel: MetricPair;
  readonly rcsFuel: MetricPair;
  readonly power: MetricPair;
  readonly radiation: MetricPair;
}

type MobilePane = 'catalog' | 'status';

// 建造セッションのスナップショットを、左右ペインと中央3D workspace に同期するUI。
// 3D候補そのものは ShipConstruction が所有し、このクラスはゲーム状態を所有しない。
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
  private readonly catalogPaneButton: Button;
  private readonly statusPaneButton: Button;
  private readonly definitions: readonly ShipModuleDefinition[] = SHIP_MODULE_CATALOG.all();
  private activeCategory: ShipModuleCategory = 'command';
  private moduleSignature = '';
  private slotSignature = '';
  private readonly moduleButtons = new Map<string, Button>();
  private readonly slotButtons = new Map<string, Button>();

  // 静的 workspace へ既存Widgetを差し込み、動的なカタログ/候補の再構築点を固定する。
  public constructor(els: HudEls) {
    this.panel = els.get('ship-construction-panel');
    this.shipName = els.get('construction-ship-name');
    this.dockName = els.get('construction-dock-name');
    this.count = els.get('construction-count');
    this.mass = els.get('construction-mass');
    this.massPreview = els.get('construction-mass-preview');
    this.hp = els.get('construction-hp');
    this.hpPreview = els.get('construction-hp-preview');
    this.capabilities = {
      thrust: this.metricPair(els, 'construction-thrust', 'construction-thrust-preview'),
      mainFuel: this.metricPair(els, 'construction-main-fuel', 'construction-main-fuel-preview'),
      rcsFuel: this.metricPair(els, 'construction-rcs-fuel', 'construction-rcs-fuel-preview'),
      power: this.metricPair(els, 'construction-power', 'construction-power-preview'),
      radiation: this.metricPair(els, 'construction-radiation', 'construction-radiation-preview'),
    };
    this.role = els.get('construction-role');
    this.warning = els.get('construction-warning');
    this.selectedModule = els.get('construction-selected-module');
    this.selectedSlot = els.get('construction-selected-slot');
    this.completion = els.get('construction-completion');
    this.categoryRoot = els.get('construction-category-tabs');
    this.moduleCards = els.get('construction-module-cards');
    this.slotList = els.get('construction-slots');

    this.hpMeter = new Meter();
    this.hpMeter.element.classList.add('construction-hp-meter');
    els.get('construction-hp-meter').appendChild(this.hpMeter.element);

    this.categoryTabs = new TabBar(CATEGORY_ITEMS, (category) => {
      this.activeCategory = category;
      this.moduleSignature = '';
      this.renderModules('');
    });
    this.categoryTabs.element.classList.add('construction-category-tabs');
    this.categoryRoot.appendChild(this.categoryTabs.element);

    const mobileTabs = els.get('construction-mobile-tabs');
    this.catalogPaneButton = new Button('部品', () => this.setMobilePane('catalog'), undefined, 'secondary');
    this.statusPaneButton = new Button('性能', () => this.setMobilePane('status'), undefined, 'secondary');
    mobileTabs.append(this.catalogPaneButton.element, this.statusPaneButton.element);
    this.setMobilePane('catalog');

    const actions = els.get('construction-actions');
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

  // 毎フレームの snapshot を、現在値・配置後差分・候補・操作可能状態へ分解して同期する。
  public sync(model: ShipConstructionPanelModel): void {
    this.panel.classList.toggle('hidden', !model.visible);
    this.shipName.textContent = model.shipName;
    this.dockName.textContent = model.dockLabel;
    this.count.textContent = String(model.moduleCount);

    this.mass.textContent = formatMetric(model.totalMass, 'kg');
    this.massPreview.textContent = previewText(model.totalMass, model.preview === null ? null : model.preview.mass, 'kg');

    this.hp.textContent = `${format(model.hp)} / ${format(model.maxHp)}`;
    this.hpPreview.textContent = previewText(model.maxHp, model.preview === null ? null : model.preview.maxHp, '');
    this.hpMeter.setRatio(model.maxHp > 0 ? model.hp / model.maxHp : 0);
    this.hpMeter.setDanger(model.maxHp > 0 && model.hp / model.maxHp < 0.3);
    this.hpMeter.setLabel(`${format(model.hp)} / ${format(model.maxHp)}`);

    this.syncMetric(this.capabilities.thrust, model.capabilities.thrust, model.preview === null ? null : model.preview.capabilities.thrust, 'N');
    this.syncMetric(this.capabilities.mainFuel, model.capabilities.mainFuel, model.preview === null ? null : model.preview.capabilities.mainFuel, '');
    this.syncMetric(this.capabilities.rcsFuel, model.capabilities.rcsFuel, model.preview === null ? null : model.preview.capabilities.rcsFuel, '');
    this.syncMetric(this.capabilities.power, model.capabilities.power, model.preview === null ? null : model.preview.capabilities.power, 'W');
    this.syncMetric(this.capabilities.radiation, model.capabilities.radiation, model.preview === null ? null : model.preview.capabilities.radiation, 'm²');

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

  // カテゴリが変わったときだけカードを組み直し、毎フレームの selection 変更ではDOMを壊さない。
  private renderModules(selectedId: string): void {
    const definitions = this.definitions.filter(definition => moduleCategory(definition) === this.activeCategory);
    const signature = `${this.activeCategory}:${definitions.map(definition => definition.id).join(',')}`;
    if (signature !== this.moduleSignature) {
      this.moduleCards.replaceChildren();
      this.moduleButtons.clear();
      for (const definition of definitions) {
        const card = document.createElement('div');
        card.className = 'construction-module-card';
        const button = new Button('', () => this.onSelectionChange?.(definition.id), undefined, 'secondary');
        button.element.title = moduleDescription(definition);
        button.element.replaceChildren(
          textSpan('construction-module-name', definition.name),
          textSpan(
            'construction-module-spec',
            `${formatDimension(definition.length)} m · ${formatMetric(definition.dryMass, 'kg')} · HP ${format(definition.maxHp)}`,
          ),
          textSpan('construction-module-ability', moduleCardAbility(definition)),
        );
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
        const button = new Button('', () => this.onSlotChange?.(slot.id), undefined, 'dense');
        button.element.classList.add('construction-slot-button');
        button.element.dataset['valid'] = String(slot.valid);
        button.element.title = slot.reason ?? 'このスロットを選択';
        button.element.replaceChildren(textSpan('construction-slot-label', slot.label));
        // 無効なスロットは選べない。理由はホバーの説明文だけに置かず、ボタン内に明示する。
        if (slot.reason !== null) {
          button.element.appendChild(textSpan('construction-slot-reason', slot.reason));
        }
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

  private setMobilePane(pane: MobilePane): void {
    this.panel.dataset['mobilePane'] = pane;
    this.catalogPaneButton.setOn(pane === 'catalog');
    this.statusPaneButton.setOn(pane === 'status');
  }

  private syncMetric(pair: MetricPair, value: number, preview: number | null, unit: MetricUnit): void {
    pair.value.textContent = formatMetric(value, unit);
    pair.preview.textContent = previewText(value, preview, unit);
  }

  private metricPair(els: HudEls, id: HudElId, previewId: HudElId): MetricPair {
    return {
      value: els.get(id),
      preview: els.get(previewId),
    };
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

// カードでは主要能力を1行に圧縮し、詳細は title へ残す。
function moduleCardAbility(definition: ShipModuleDefinition): string {
  const abilities = definition.abilities;
  const values: string[] = [];
  if (abilities.thrust !== undefined) values.push(`推力 ${formatMetric(abilities.thrust, 'N')}`);
  if (abilities.fuelCapacity !== undefined) {
    values.push(`${abilities.fuelKind === 'rcs' ? 'RCS' : '主'}燃料 ${formatMetric(abilities.fuelCapacity, '')}`);
  }
  if (abilities.powerGeneration !== undefined) values.push(`発電 ${formatMetric(abilities.powerGeneration, 'W')}`);
  if (abilities.radiationArea !== undefined) values.push(`放熱 ${formatMetric(abilities.radiationArea, 'm²')}`);
  if (abilities.weaponDamage !== undefined) values.push(`威力 ${format(abilities.weaponDamage)}`);
  if (abilities.armorReduction !== undefined) values.push(`装甲 ${Math.round(abilities.armorReduction * 100)}%`);
  return values.slice(0, 2).join(' · ') || '構造モジュール';
}

// ホバー/読み上げ用に、部品が持つ主要能力を短い説明へまとめる。
function moduleDescription(definition: ShipModuleDefinition): string {
  const abilities = definition.abilities;
  const values: string[] = [];
  if (abilities.thrust !== undefined) values.push(`推力 ${formatMetric(abilities.thrust, 'N')}`);
  if (abilities.fuelCapacity !== undefined) values.push(`容量 ${formatMetric(abilities.fuelCapacity, '')}`);
  if (abilities.powerGeneration !== undefined) values.push(`発電 ${formatMetric(abilities.powerGeneration, 'W')}`);
  if (abilities.radiationArea !== undefined) values.push(`放熱面積 ${formatMetric(abilities.radiationArea, 'm²')}`);
  return values.length === 0 ? definition.name : values.join(' / ');
}

function textSpan(className: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

type MetricUnit = '' | 'kg' | 'N' | 'W' | 'm²';

function previewText(current: number, preview: number | null, unit: MetricUnit): string {
  if (preview === null) return '';
  const delta = preview - current;
  if (Math.abs(delta) < 1e-9) return '';
  return `→ ${formatMetric(preview, unit)} · ${delta > 0 ? '+' : ''}${formatMetric(delta, unit)}`;
}

function formatMetric(value: number, unit: MetricUnit): string {
  const abs = Math.abs(value);
  if (unit === 'N' && abs >= 1000) return `${formatDecimal(value / 1000)} kN`;
  if (unit === 'W' && abs >= 1000) return `${formatDecimal(value / 1000)} kW`;
  if (unit === 'm²') return `${formatDecimal(value)} m²`;
  const body = format(value);
  return unit === '' ? body : `${body} ${unit}`;
}

function formatDecimal(value: number): string {
  return Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

function formatDimension(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// role の内部語彙をUIの短い日本語ラベルへ変換する。
function roleLabel(role: ConstructionRole): string {
  return role === 'ship' ? '船' : role === 'base' ? '基地' : '物資';
}

// 全ての建造数値の丸めと桁区切りを一箇所へ寄せる。
function format(value: number): string {
  return Math.round(value).toLocaleString();
}
