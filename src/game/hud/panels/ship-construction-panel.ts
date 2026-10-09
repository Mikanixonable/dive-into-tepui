import { Button, buildSpan, Meter } from '../../../hud/widgets';
import { ShipConstructionCatalog } from './ship-construction-catalog';
import { formatConstructionMetric, formatConstructionNumber } from './ship-construction-format';
import { hiddenShipConstructionModel } from '../../ship/ship-construction-types';
import type { ConstructionRole, ShipConstructionPanelModel } from '../../ship/ship-construction-types';
import type { HudEls, HudElId } from '../hud-els';
import type { ConstructionMetricUnit } from './ship-construction-format';

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

// 建造セッションの表示と操作可能状態を同期し、建造操作を通知する。
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
  private readonly catalog: ShipConstructionCatalog;
  private readonly slotList: HTMLElement;
  private readonly place: Button;
  private readonly remove: Button;
  private readonly finish: Button;
  private readonly discard: Button;
  private readonly catalogPaneButton: Button;
  private readonly statusPaneButton: Button;
  private slotSignature = '';
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
    this.slotList = els.get('construction-slots');

    this.hpMeter = new Meter();
    this.hpMeter.element.classList.add('construction-hp-meter');
    els.get('construction-hp-meter').appendChild(this.hpMeter.element);

    this.catalog = new ShipConstructionCatalog(
      els.get('construction-category-tabs'),
      els.get('construction-module-cards'),
      definitionId => this.onSelectionChange?.(definitionId),
    );

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
    this.sync(hiddenShipConstructionModel());
  }

  // 毎フレームの snapshot を、現在値・配置後差分・候補・操作可能状態へ分解して同期する。
  public sync(model: ShipConstructionPanelModel): void {
    this.panel.classList.toggle('hidden', !model.visible);
    this.shipName.textContent = model.shipName;
    this.dockName.textContent = model.dockLabel;
    this.count.textContent = String(model.moduleCount);

    this.mass.textContent = formatConstructionMetric(model.totalMass, 'kg');
    this.massPreview.textContent = previewText(model.totalMass, model.preview === null ? null : model.preview.mass, 'kg');

    this.hp.textContent = `${formatConstructionNumber(model.hp)} / ${formatConstructionNumber(model.maxHp)}`;
    this.hpPreview.textContent = previewText(model.maxHp, model.preview === null ? null : model.preview.maxHp, '');
    this.hpMeter.setRatio(model.maxHp > 0 ? model.hp / model.maxHp : 0);
    this.hpMeter.setDanger(model.maxHp > 0 && model.hp / model.maxHp < 0.3);
    this.hpMeter.setLabel(`${formatConstructionNumber(model.hp)} / ${formatConstructionNumber(model.maxHp)}`);

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
    this.catalog.sync(model.selectedDefinitionId);
    this.renderSlots(model);
    this.place.setEnabled(model.canPlace);
    this.remove.setEnabled(model.canRemove);
    this.finish.setEnabled(model.canFinish);
    this.discard.setEnabled(model.visible);
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
        button.element.replaceChildren(buildSpan('construction-slot-label', slot.label));
        // 無効なスロットは選べない。理由はホバーの説明文だけに置かず、ボタン内に明示する。
        if (slot.reason !== null) {
          button.element.appendChild(buildSpan('construction-slot-reason', slot.reason));
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

  // 小画面で表示するペインと切替ボタンの押下表示を揃える。
  private setMobilePane(pane: MobilePane): void {
    this.panel.dataset['mobilePane'] = pane;
    this.catalogPaneButton.setOn(pane === 'catalog');
    this.statusPaneButton.setOn(pane === 'status');
  }

  // 現在値と配置後の増減を対応する表示へ反映する。
  private syncMetric(pair: MetricPair, value: number, preview: number | null, unit: ConstructionMetricUnit): void {
    pair.value.textContent = formatConstructionMetric(value, unit);
    pair.preview.textContent = previewText(value, preview, unit);
  }

  // 現在値と配置後差分の表示要素を組にする。
  private metricPair(els: HudEls, id: HudElId, previewId: HudElId): MetricPair {
    return {
      value: els.get(id),
      preview: els.get(previewId),
    };
  }
}

// 配置後の値と増減を示し、差分がないときは空文字を返す。
function previewText(current: number, preview: number | null, unit: ConstructionMetricUnit): string {
  if (preview === null) return '';
  const delta = preview - current;
  if (Math.abs(delta) < 1e-9) return '';
  return `→ ${formatConstructionMetric(preview, unit)} · ${delta > 0 ? '+' : ''}${formatConstructionMetric(delta, unit)}`;
}

// role の内部語彙をUIの短い日本語ラベルへ変換する。
function roleLabel(role: ConstructionRole): string {
  return role === 'ship' ? '船' : role === 'base' ? '基地' : '物資';
}
