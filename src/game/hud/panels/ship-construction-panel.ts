// 建造セッションの表示と操作可能状態を同期し、建造操作を通知するパネル。
// 「いま何を手に持ち、どこへ置けて、船体全体がどう変わるか」に答える区画で組む。
// 手持ちの操作は手元バー(ship-construction-hand)、選択中モジュールの操作は脇へ
// 追従するメニュー(ship-construction-selection-menu)、右ペインは性能・候補・履歴のタブ。
import { Button, buildSpan, Meter, TabBar } from '../../../hud/widgets';
import { ARMOR_WARNING_RATIO, armorAlarmLevel } from '../../alarm/alarm-level';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { ShipConstructionCatalog } from './ship-construction-catalog';
import { ShipConstructionHand } from './ship-construction-hand';
import { ShipConstructionSelectionMenu } from './ship-construction-selection-menu';
import {
  formatConstructionDelta, formatConstructionMetric, formatConstructionNumber,
} from './ship-construction-format';
import { hiddenShipConstructionModel } from '../../ship/ship-construction-types';
import type {
  ConstructionCardDragEvent, ConstructionRole, ShipConstructionPanelModel,
} from '../../ship/ship-construction-types';
import type { HudEls, HudElId } from '../hud-els';
import type { ConstructionMetricUnit } from './ship-construction-format';
import type { Projected } from '../../../math/projection';

interface MetricPair {
  readonly value: HTMLElement;
  readonly preview: HTMLElement;
}

interface CapabilityElements {
  readonly deltaV: MetricPair;
  readonly acceleration: MetricPair;
  readonly thrust: MetricPair;
  readonly mainFuel: MetricPair;
  readonly rcsFuel: MetricPair;
  readonly power: MetricPair;
  readonly radiation: MetricPair;
}

type MobilePane = 'catalog' | 'status';

// 右ペインの読み替えタブ。性能が既定。
type StatePane = 'performance' | 'targets' | 'history';

const STATE_PANE_ITEMS: readonly (readonly [StatePane, string])[] = [
  ['performance', '性能'], ['targets', '候補'], ['history', '履歴'],
];

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
  public onReattach: (() => void) | null = null;
  public onRelease: (() => void) | null = null;
  public onRotate: ((delta: 1 | -1) => void) | null = null;
  public onSwapEnds: (() => void) | null = null;
  public onCycleSymmetry: (() => void) | null = null;
  public onUndo: (() => void) | null = null;
  public onRedo: (() => void) | null = null;
  public onJumpHistory: ((index: number) => void) | null = null;
  public onFinish: (() => void) | null = null;
  public onDiscard: (() => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly shipName: HTMLElement;
  private readonly count: HTMLElement;
  private readonly mass: HTMLElement;
  private readonly massPreview: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly hpMeter: Meter;
  private readonly hpPreview: HTMLElement;
  private readonly capabilities: CapabilityElements;
  private readonly role: HTMLElement;
  private readonly catalog: ShipConstructionCatalog;
  private readonly hand: ShipConstructionHand;
  private readonly selectionMenu: ShipConstructionSelectionMenu;
  private readonly stateTabs: TabBar<StatePane>;
  private readonly stateBodies: Readonly<Record<StatePane, HTMLElement>>;
  private readonly slotList: HTMLElement;
  private readonly historyList: HTMLElement;
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
  // 選択メニューの追従先(表示の導出が毎フレーム書き込む選択モジュールの画面位置)と、
  // 直近の model から導いたメニューの可否。両方が揃ったときだけメニューを出す。
  private selectionAnchor: Projected | null = null;
  private menuSelection: { canEdit: boolean } | null = null;

  // 静的 workspace へ既存Widgetを差し込み、動的なカタログ/候補/履歴の再構築点を固定する。
  public constructor(els: HudEls) {
    this.panel = els.get('ship-construction-panel');
    this.shipName = els.get('construction-ship-name');
    this.count = els.get('construction-count');
    this.mass = els.get('construction-mass');
    this.massPreview = els.get('construction-mass-preview');
    this.hp = els.get('construction-hp');
    this.hpPreview = els.get('construction-hp-preview');
    this.capabilities = {
      deltaV: this.metricPair(els, 'construction-delta-v', 'construction-delta-v-preview'),
      acceleration: this.metricPair(els, 'construction-acceleration', 'construction-acceleration-preview'),
      thrust: this.metricPair(els, 'construction-thrust', 'construction-thrust-preview'),
      mainFuel: this.metricPair(els, 'construction-main-fuel', 'construction-main-fuel-preview'),
      rcsFuel: this.metricPair(els, 'construction-rcs-fuel', 'construction-rcs-fuel-preview'),
      power: this.metricPair(els, 'construction-power', 'construction-power-preview'),
      radiation: this.metricPair(els, 'construction-radiation', 'construction-radiation-preview'),
    };
    this.role = els.get('construction-role');
    this.slotList = els.get('construction-slots');
    this.historyList = els.get('construction-history-list');

    // 動的に組む表示部品を、静的な配置枠へ差し込む。
    this.hpMeter = new Meter();
    this.hpMeter.setMarks(null, ARMOR_WARNING_RATIO);
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

    // 小画面用のペイン切替を組む。手元バーと 3D は切り替えによらず常に見える。
    const mobileTabs = els.get('construction-mobile-tabs');
    this.catalogPaneButton = new Button('部品', () => this.setMobilePane('catalog'), undefined, 'secondary');
    this.statusPaneButton = new Button('船体', () => this.setMobilePane('status'), undefined, 'secondary');
    mobileTabs.append(this.catalogPaneButton.element, this.statusPaneButton.element);
    this.setMobilePane('catalog');

    // 3D の下の手元バー。状態の言い切りと、手持ちの間に効く操作だけを持つ。
    this.hand = new ShipConstructionHand(els, {
      onPlace: () => this.onPlace?.(),
      onRelease: () => this.onRelease?.(),
      onRotate: (delta) => this.onRotate?.(delta),
      onSwapEnds: () => this.onSwapEnds?.(),
      onCycleSymmetry: () => this.onCycleSymmetry?.(),
    });

    // 選んだモジュールの脇へ追従する操作メニュー。marker レイヤの子として組む。
    const menuLayer = this.panel.closest('#hud')?.querySelector<HTMLElement>('#hud-layer-marker')
      ?? this.panel;
    this.selectionMenu = new ShipConstructionSelectionMenu(menuLayer, {
      onRotate: (delta) => this.onRotate?.(delta),
      onSwapEnds: () => this.onSwapEnds?.(),
      onReattach: () => this.onReattach?.(),
      onRemove: () => this.onRemove?.(),
      onDuplicate: () => this.onDuplicate?.(),
    });

    // 右ペインの読み替えタブとその本文。
    this.stateBodies = {
      performance: els.get('construction-state-performance'),
      targets: els.get('construction-state-targets'),
      history: els.get('construction-state-history'),
    };
    this.stateTabs = new TabBar<StatePane>(STATE_PANE_ITEMS, (pane) => this.setStatePane(pane));
    els.get('construction-state-tabs').appendChild(this.stateTabs.element);
    this.setStatePane('performance');

    // 履歴の取り消し・やり直し。
    const historyActions = els.get('construction-history-actions');
    this.undo = new Button('取り消し', () => this.onUndo?.(), undefined, 'secondary', K.constructionUndo.label);
    this.redo = new Button('やり直し', () => this.onRedo?.(), undefined, 'secondary', K.constructionRedo.label);
    historyActions.append(this.undo.element, this.redo.element);

    // 建造の締めくくり。タブによらず下端に常に見える。
    const closeActions = els.get('construction-close-actions');
    this.finish = new Button('建造終了', () => this.onFinish?.(), undefined, 'primary', K.pauseMenu.label);
    this.discard = new Button('変更をすべて取り消す', () => this.onDiscard?.(), undefined, 'secondary');
    const destructive = document.createElement('div');
    destructive.className = 'construction-destructive-actions';
    destructive.appendChild(this.discard.element);
    closeActions.append(this.finish.element, destructive);

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

    // 手元バーは3状態の言い切りと状態ごとの操作を自分で組む。
    this.hand.sync(model);

    // 選択メニューが出せるのは選んでいて手が空いている間だけ。可否は model から、
    // 追従位置は syncSelectionMenu から別々に届くのでここで合わせる。
    this.menuSelection = model.visible && model.selection !== null && model.held === null
      ? { canEdit: model.selection.canEdit }
      : null;
    this.updateSelectionMenu();

    // 船体全体の性能と、指している候補へ置いたときの差分。
    this.count.textContent = String(model.moduleCount);
    this.mass.textContent = formatConstructionMetric(model.totalMass, 'kg');
    const preview = model.preview;
    this.syncPreview(this.massPreview, model.totalMass, preview?.mass ?? null, preview !== null, 'kg');
    this.hp.textContent = `${formatConstructionNumber(model.hp)} / ${formatConstructionNumber(model.maxHp)}`;
    this.syncPreview(this.hpPreview, model.maxHp, preview?.maxHp ?? null, preview !== null, '');
    this.hpMeter.setRatio(model.maxHp > 0 ? model.hp / model.maxHp : 0);
    this.hpMeter.setLevel(armorAlarmLevel(model.hp, model.maxHp));
    this.hpMeter.setLabel(`${formatConstructionNumber(model.hp)} / ${formatConstructionNumber(model.maxHp)}`);
    this.syncMetric(this.capabilities.deltaV, model.capabilities.deltaV, preview?.capabilities.deltaV ?? null, preview !== null, 'm/s');
    this.syncMetric(this.capabilities.acceleration, model.capabilities.acceleration, preview?.capabilities.acceleration ?? null, preview !== null, 'm/s²');
    this.syncMetric(this.capabilities.thrust, model.capabilities.thrust, preview?.capabilities.thrust ?? null, preview !== null, 'N');
    this.syncMetric(this.capabilities.mainFuel, model.capabilities.mainFuel, preview?.capabilities.mainFuel ?? null, preview !== null, '');
    this.syncMetric(this.capabilities.rcsFuel, model.capabilities.rcsFuel, preview?.capabilities.rcsFuel ?? null, preview !== null, '');
    this.syncMetric(this.capabilities.power, model.capabilities.power, preview?.capabilities.power ?? null, preview !== null, 'W');
    this.syncMetric(this.capabilities.radiation, model.capabilities.radiation, preview?.capabilities.radiation ?? null, preview !== null, 'm²');
    this.role.textContent = roleLabel(model.role);
    this.role.dataset['role'] = model.role;

    // 一覧と操作ボタンの可否を model の値へ揃える。
    this.catalog.sync(model.held?.catalogId ?? null, model.held?.blueprintId ?? null, model.blueprints);
    this.renderSlots(model);
    this.renderHistory(model);
    this.undo.setEnabled(model.history.canUndo);
    this.redo.setEnabled(model.history.canRedo);
    this.finish.setEnabled(model.visible);
    this.discard.setEnabled(model.visible && model.history.names.length > 1);
  }

  // 選択中モジュールの画面位置を受け取り、選択メニューの追従先として記録する。
  // 表示の導出が毎フレーム呼ぶ。選択が無い・投影できないときは null。
  public syncSelectionMenu(anchor: Projected | null): void {
    this.selectionAnchor = anchor;
    this.updateSelectionMenu();
  }

  // model 由来の可否と追従位置を合わせてメニューを同期する。両方揃うまでは出さない。
  private updateSelectionMenu(): void {
    const selection = this.menuSelection;
    const anchor = this.selectionAnchor;
    this.selectionMenu.sync(selection === null || anchor === null ? null : {
      x: anchor.x, y: anchor.y, front: anchor.front,
      canEdit: selection.canEdit,
    });
  }

  // 右ペインで読む本文をタブへ合わせる。タブ以外の部分(役割・締めのボタン)は常に見える。
  private setStatePane(pane: StatePane): void {
    this.stateTabs.setSelected(pane);
    for (const [name, body] of Object.entries(this.stateBodies)) {
      body.classList.toggle('hidden', name !== pane);
    }
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

  // 現在値と配置後の増減を対応する表示へ反映する。値が無い(null)項目は「—」とする。
  private syncMetric(
    pair: MetricPair, value: number | null, preview: number | null, hasPreview: boolean,
    unit: ConstructionMetricUnit,
  ): void {
    pair.value.textContent = value === null ? '—' : formatConstructionMetric(value, unit);
    this.syncPreview(pair.preview, value, preview, hasPreview, unit);
  }

  // 配置後差分を「→ 変化後の値 (±差)」の形で同期する。hasPreview は試し置きの見積りの有無。
  // 値なし(null)が絡む変化は変化後の値だけを出す。
  private syncPreview(
    el: HTMLElement, current: number | null, preview: number | null, hasPreview: boolean,
    unit: ConstructionMetricUnit,
  ): void {
    if (!hasPreview || preview === current
      || (preview !== null && current !== null && Math.abs(preview - current) < 1e-9)) {
      el.textContent = '';
      return;
    }
    if (current === null || preview === null) {
      el.textContent = `→ ${preview === null ? '—' : formatConstructionMetric(preview, unit)}`;
      return;
    }
    const delta = preview - current;
    el.textContent = `→ ${formatConstructionMetric(preview, unit)} (${delta > 0 ? '+' : ''}${formatConstructionDelta(delta, unit)})`;
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
