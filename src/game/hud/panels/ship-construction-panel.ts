// 建造セッションの表示と操作可能状態を同期し、建造操作を通知するパネル。
// 「いま何を手に持ち、どこへ置けて、船体全体がどう変わるか」に答える区画で組む。
import { Button, buildSpan, Meter, ValueInput } from '../../../hud/widgets';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { ShipConstructionCatalog } from './ship-construction-catalog';
import {
  formatConstructionMetric, formatConstructionNumber, formatConstructionOrientation,
} from './ship-construction-format';
import { hiddenShipConstructionModel } from '../../ship/ship-construction-types';
import type {
  ConstructionCardDragEvent, ConstructionRole, ShipConstructionPanelModel,
} from '../../ship/ship-construction-types';
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

export class ShipConstructionPanel {
  public get element(): HTMLElement { return this.panel; }
  public onSelectionChange: ((definitionId: string) => void) | null = null;
  public onBlueprintHold: ((blueprintId: string) => void) | null = null;
  public onCardDrag: ((event: ConstructionCardDragEvent) => void) | null = null;
  public onBlueprintRename: ((id: string, name: string) => void) | null = null;
  public onBlueprintDelete: ((id: string) => void) | null = null;
  public onSlotChange: ((slotId: string) => void) | null = null;
  public onPlace: (() => void) | null = null;
  public onRemove: (() => void) | null = null;
  public onDuplicate: (() => void) | null = null;
  public onRelease: (() => void) | null = null;
  public onRotate: ((delta: 1 | -1) => void) | null = null;
  public onSwapEnds: (() => void) | null = null;
  public onCycleSymmetry: (() => void) | null = null;
  public onSaveBlueprint: ((name: string) => void) | null = null;
  public onUndo: (() => void) | null = null;
  public onRedo: (() => void) | null = null;
  public onJumpHistory: ((index: number) => void) | null = null;
  public onFinish: (() => void) | null = null;
  public onDiscard: (() => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly shipName: HTMLElement;
  private readonly heldName: HTMLElement;
  private readonly heldOrientation: HTMLElement;
  private readonly heldSymmetry: HTMLElement;
  private readonly selectedName: HTMLElement;
  private readonly blueprintNote: HTMLElement;
  private readonly count: HTMLElement;
  private readonly mass: HTMLElement;
  private readonly massPreview: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly hpMeter: Meter;
  private readonly hpPreview: HTMLElement;
  private readonly capabilities: CapabilityElements;
  private readonly role: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly catalog: ShipConstructionCatalog;
  private readonly slotList: HTMLElement;
  private readonly historyList: HTMLElement;
  private readonly blueprintName: ValueInput;
  private readonly rollLeft: Button;
  private readonly rollRight: Button;
  private readonly swapEnds: Button;
  private readonly symmetry: Button;
  private readonly release: Button;
  private readonly remove: Button;
  private readonly duplicate: Button;
  private readonly saveBlueprint: Button;
  private readonly place: Button;
  private readonly undo: Button;
  private readonly redo: Button;
  private readonly finish: Button;
  private readonly discard: Button;
  private readonly catalogPaneButton: Button;
  private readonly statusPaneButton: Button;
  private slotSignature = '';
  private readonly slotButtons = new Map<string, Button>();
  private historySignature = '';
  private readonly historyButtons: Button[] = [];

  // 静的 workspace へ既存Widgetを差し込み、動的なカタログ/候補/履歴の再構築点を固定する。
  public constructor(els: HudEls) {
    this.panel = els.get('ship-construction-panel');
    this.shipName = els.get('construction-ship-name');
    this.heldName = els.get('construction-held-name');
    this.heldOrientation = els.get('construction-held-orientation');
    this.heldSymmetry = els.get('construction-held-symmetry');
    this.selectedName = els.get('construction-selected-name');
    this.blueprintNote = els.get('construction-blueprint-note');
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
    this.slotList = els.get('construction-slots');
    this.historyList = els.get('construction-history-list');

    // 動的に組む表示部品を、静的な配置枠へ差し込む。
    this.hpMeter = new Meter();
    this.hpMeter.element.classList.add('construction-hp-meter');
    els.get('construction-hp-meter').appendChild(this.hpMeter.element);

    this.catalog = new ShipConstructionCatalog(
      els.get('construction-category-tabs'),
      els.get('construction-module-cards'),
      {
        onSelectModule: (definitionId) => this.onSelectionChange?.(definitionId),
        onSelectBlueprint: (blueprintId) => this.onBlueprintHold?.(blueprintId),
        onRenameBlueprint: (id, name) => this.onBlueprintRename?.(id, name),
        onDeleteBlueprint: (id) => this.onBlueprintDelete?.(id),
        onCardDrag: (event) => this.onCardDrag?.(event),
      },
    );

    // 小画面用のペイン切替を組む。
    const mobileTabs = els.get('construction-mobile-tabs');
    this.catalogPaneButton = new Button('部品', () => this.setMobilePane('catalog'), undefined, 'secondary');
    this.statusPaneButton = new Button('性能', () => this.setMobilePane('status'), undefined, 'secondary');
    mobileTabs.append(this.catalogPaneButton.element, this.statusPaneButton.element);
    this.setMobilePane('catalog');

    // 手持ちの操作: ロール左右・取り付ける端・対称数・手放す。キー割り当てと同じ操作。
    const heldActions = els.get('construction-held-actions');
    this.rollLeft = new Button(`⟲ [${K.constructionRollLeft.label}]`, () => this.onRotate?.(-1), undefined, 'secondary');
    this.rollRight = new Button(`⟳ [${K.constructionRollRight.label}]`, () => this.onRotate?.(1), undefined, 'secondary');
    this.swapEnds = new Button(`端 [${K.constructionSwapEnds.label}]`, () => this.onSwapEnds?.(), undefined, 'secondary');
    this.symmetry = new Button(`対称 [${K.constructionSymmetry.label}]`, () => this.onCycleSymmetry?.(), undefined, 'secondary');
    this.release = new Button('手放す', () => this.onRelease?.(), undefined, 'secondary');
    heldActions.append(
      this.rollLeft.element, this.rollRight.element, this.swapEnds.element,
      this.symmetry.element, this.release.element,
    );

    // 選択中の操作: 撤去・複製・設計図として保存(名前付き)。
    const selectionActions = els.get('construction-selection-actions');
    this.remove = new Button(`撤去 [${K.constructionRemove.label}]`, () => this.onRemove?.(), undefined, 'secondary');
    this.duplicate = new Button(`複製 [${K.constructionDuplicate.label}]`, () => this.onDuplicate?.(), undefined, 'secondary');
    selectionActions.append(this.remove.element, this.duplicate.element);
    const blueprintForm = els.get('construction-blueprint-form');
    this.blueprintName = new ValueInput({ type: 'text', placeholder: '設計図の名前' }, () => undefined);
    this.saveBlueprint = new Button(
      '設計図として保存', () => this.onSaveBlueprint?.(this.blueprintName.element.value), undefined, 'secondary',
    );
    blueprintForm.append(this.blueprintName.element, this.saveBlueprint.element);

    // 履歴の取り消し・やり直し。
    const historyActions = els.get('construction-history-actions');
    this.undo = new Button(`取り消し [${K.constructionUndo.label}]`, () => this.onUndo?.(), undefined, 'secondary');
    this.redo = new Button(`やり直し [${K.constructionRedo.label}]`, () => this.onRedo?.(), undefined, 'secondary');
    historyActions.append(this.undo.element, this.redo.element);

    // 建造の締めくくり: 配置・終了・全取り消し。
    const actions = els.get('construction-actions');
    this.place = new Button(`配置 [${K.constructionPlace.label}]`, () => this.onPlace?.(), undefined, 'primary');
    this.finish = new Button('建造終了', () => this.onFinish?.(), undefined, 'primary');
    this.discard = new Button('変更をすべて取り消す', () => this.onDiscard?.(), undefined, 'secondary');
    const destructive = document.createElement('div');
    destructive.className = 'construction-destructive-actions';
    destructive.appendChild(this.discard.element);
    actions.append(this.place.element, this.finish.element, destructive);
    this.sync(hiddenShipConstructionModel());
  }

  // カタログの表示カテゴリをタブの並び順の index で選ぶ。範囲外は無視する。
  public selectCatalogCategory(index: number): void {
    this.catalog.selectCategory(index);
  }

  // 毎フレームの snapshot を、現在値・配置後差分・候補・操作可能状態へ分解して同期する。
  public sync(model: ShipConstructionPanelModel): void {
    this.panel.classList.toggle('hidden', !model.visible);
    this.shipName.textContent = model.shipName;

    // 手持ち。
    this.heldName.textContent = model.held?.name ?? '—';
    this.heldOrientation.textContent = model.held === null
      ? '—' : formatConstructionOrientation(model.held.orientation);
    this.heldSymmetry.textContent = model.held === null ? '—' : `×${model.held.symmetry}`;
    const heldActionsEnabled = model.held !== null;
    this.rollLeft.setEnabled(heldActionsEnabled || model.selection?.canEdit === true);
    this.rollRight.setEnabled(heldActionsEnabled || model.selection?.canEdit === true);
    this.swapEnds.setEnabled(heldActionsEnabled || model.selection?.canEdit === true);
    this.symmetry.setEnabled(heldActionsEnabled);
    this.release.setEnabled(model.held !== null || model.selection !== null);

    // 選択中と設計図の保存。
    this.selectedName.textContent = model.selection?.name ?? '—';
    this.remove.setEnabled(model.canRemove);
    this.duplicate.setEnabled(model.selection?.canEdit === true);
    const canSaveBlueprint = model.selection?.canEdit === true && model.blueprintRecordReason === null;
    this.saveBlueprint.setEnabled(canSaveBlueprint);
    this.blueprintName.element.disabled = !canSaveBlueprint;
    this.blueprintNote.textContent = model.blueprintRecordReason ?? '';
    this.blueprintNote.classList.toggle('hidden', model.blueprintRecordReason === null);

    // 船体全体の性能と、指している候補へ置いたときの差分。
    this.count.textContent = String(model.moduleCount);
    this.mass.textContent = formatConstructionMetric(model.totalMass, 'kg');
    this.syncPreview(this.massPreview, model.totalMass, model.preview?.mass ?? null, 'kg');
    this.hp.textContent = `${formatConstructionNumber(model.hp)} / ${formatConstructionNumber(model.maxHp)}`;
    this.syncPreview(this.hpPreview, model.maxHp, model.preview?.maxHp ?? null, '');
    this.hpMeter.setRatio(model.maxHp > 0 ? model.hp / model.maxHp : 0);
    this.hpMeter.setDanger(model.maxHp > 0 && model.hp / model.maxHp < 0.3);
    this.hpMeter.setLabel(`${formatConstructionNumber(model.hp)} / ${formatConstructionNumber(model.maxHp)}`);
    this.syncMetric(this.capabilities.thrust, model.capabilities.thrust, model.preview?.capabilities.thrust ?? null, 'N');
    this.syncMetric(this.capabilities.mainFuel, model.capabilities.mainFuel, model.preview?.capabilities.mainFuel ?? null, '');
    this.syncMetric(this.capabilities.rcsFuel, model.capabilities.rcsFuel, model.preview?.capabilities.rcsFuel ?? null, '');
    this.syncMetric(this.capabilities.power, model.capabilities.power, model.preview?.capabilities.power ?? null, 'W');
    this.syncMetric(this.capabilities.radiation, model.capabilities.radiation, model.preview?.capabilities.radiation ?? null, 'm²');
    this.role.textContent = roleLabel(model.role);
    this.role.dataset['role'] = model.role;
    this.warning.textContent = model.warning ?? '';
    this.warning.classList.toggle('hidden', model.warning === null);

    // 一覧と操作ボタンの可否を model の値へ揃える。
    this.catalog.sync(model.held?.catalogId ?? null, model.held?.blueprintId ?? null, model.blueprints);
    this.renderSlots(model);
    this.renderHistory(model);
    this.undo.setEnabled(model.history.canUndo);
    this.redo.setEnabled(model.history.canRedo);
    this.place.setEnabled(model.canPlace);
    this.finish.setEnabled(model.visible);
    this.discard.setEnabled(model.visible && model.history.names.length > 1);
  }

  // 候補一覧に変更があった場合のみボタンを再生成し、選択状態は毎フレーム反映する。
  private renderSlots(model: ShipConstructionPanelModel): void {
    const signature = model.targets.map(slot => `${slot.id}:${slot.valid}:${slot.reason ?? ''}`).join('|');
    if (signature !== this.slotSignature) {
      this.slotList.replaceChildren();
      this.slotButtons.clear();
      for (const slot of model.targets) {
        const button = new Button('', () => this.onSlotChange?.(slot.id), undefined, 'dense');
        button.element.classList.add('construction-slot-button');
        button.element.dataset['valid'] = String(slot.valid);
        button.element.title = slot.reason ?? 'この取り付け先を選ぶ';
        button.element.replaceChildren(buildSpan('construction-slot-label', slot.label));
        // 無効な候補は選べない。理由はホバーの説明文だけに置かず、ボタン内に明示する。
        if (slot.reason !== null) {
          button.element.appendChild(buildSpan('construction-slot-reason', slot.reason));
        }
        this.slotList.appendChild(button.element);
        this.slotButtons.set(slot.id, button);
      }
      this.slotSignature = signature;
    }
    for (const slot of model.targets) {
      const button = this.slotButtons.get(slot.id);
      if (button === undefined) continue;
      button.setOn(slot.id === model.pointedTargetId);
      button.element.dataset['valid'] = String(slot.valid);
    }
  }

  // 履歴一覧に変更があった場合のみボタンを再生成する。新しい操作が先頭に来るよう逆順で並べる。
  private renderHistory(model: ShipConstructionPanelModel): void {
    const signature = model.history.names.join('|');
    if (signature !== this.historySignature) {
      this.historyList.replaceChildren();
      this.historyButtons.length = 0;
      for (let index = model.history.names.length - 1; index >= 0; index--) {
        const position = index;
        const button = new Button(model.history.names[index] ?? '', () => this.onJumpHistory?.(position), undefined, 'dense');
        button.element.classList.add('construction-history-item');
        this.historyList.appendChild(button.element);
        this.historyButtons.push(button);
      }
      this.historySignature = signature;
    }
    for (const [offset, button] of this.historyButtons.entries()) {
      button.setOn(model.history.names.length - 1 - offset === model.history.position);
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
    this.syncPreview(pair.preview, value, preview, unit);
  }

  // 配置後差分の文字と、増減の向きを色で分ける印を同期する。
  private syncPreview(el: HTMLElement, current: number, preview: number | null, unit: ConstructionMetricUnit): void {
    if (preview === null || Math.abs(preview - current) < 1e-9) {
      el.textContent = '';
      el.dataset['delta'] = '';
      return;
    }
    const delta = preview - current;
    el.textContent = `→ ${formatConstructionMetric(preview, unit)} · ${delta > 0 ? '+' : ''}${formatConstructionMetric(delta, unit)}`;
    el.dataset['delta'] = delta > 0 ? 'up' : 'down';
  }

  // 現在値と配置後差分の表示要素を組にする。
  private metricPair(els: HudEls, id: HudElId, previewId: HudElId): MetricPair {
    return {
      value: els.get(id),
      preview: els.get(previewId),
    };
  }
}

// role の内部語彙をUIの短い日本語ラベルへ変換する。
function roleLabel(role: ConstructionRole): string {
  return role === 'ship' ? '船' : role === 'base' ? '基地' : '物資';
}
