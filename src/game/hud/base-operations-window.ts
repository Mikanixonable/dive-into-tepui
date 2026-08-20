// 基地操作ウィンドウ: 1つの基地について、格納艦艇の一覧と発進、搭載部品の修理・補給・換装、
// 部品の生産と在庫を扱う。`draggable-window.ts` のドラッグ・📌クリップ・✕・OverlayManager 登録を
// 土台に、TabBar で3つの面を切り替える。資源の増減・生産可否の判定は economy/ と vessel/ が持ち、
// このクラスはそれらを呼んで結果を描くだけ。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import type { Vessel, DockedVesselEntry } from '../vessel/vessel';
import type { AnyPart, Part, PropellantTankPart } from '../game-entity/parts';
import { propellantTankCapacity, TANK_MATERIALS } from '../economy/propellant-compatibility';
import { Button, Meter, TabBar, ValueInput } from './widgets';
import { buildPartFrom, producibleParts } from '../vessel/default-blueprints';
import { baseFacilities, basePowerAvailable } from '../vessel/base-module';
import { producibility, type ProducibilityBlueprint, type Requirement } from '../economy/producibility';
import {
  consumeProductionResources, partProductionBlueprintOf, productionResourceDemand,
  refuelBlueprintOf, repairAllBlueprintOf, repairBlueprintOf,
} from '../vessel/production';
import { RESOURCES, RESOURCE_IDS, type ResourceId } from '../economy/resource';
import { formatPartMeta, formatResourceAmount } from './inventory-labels';
import { DraggableWindow } from './draggable-window';
import { ObjectPicker, type ObjectPickerGroup } from './object-picker';
import type { OverlayManager } from './overlay-manager';
import { hasCorePart } from '../vessel/capabilities';

// 推進剤タンク3種(oxidizer_tank/reductant_tank/rcs_tank)の判定を一箇所に集約する。
// この3種は搭載場所が違うだけで、補給という操作に対しては同じものとして扱う。
function isPropellantTankPart(part: Part): part is PropellantTankPart {
  return part.type === 'oxidizer_tank' || part.type === 'reductant_tank' || part.type === 'rcs_tank';
}

const STYLE = `
/* プロパティウィンドウより中身が広いので、この窓だけ横幅の上限を上げる。 */
#hud .dw-window:has(> .bow-body) { max-width: 420px; width: min(420px, 92vw); }
#hud .bow-body { display: flex; flex-direction: column; min-height: 0; }
#hud .bow-tabs { padding: 0 var(--space-4) var(--space-3); }
#hud .bow-tabs .w-btn { flex: 1 0 auto; }
#hud .bow-content {
  max-height: 52vh; max-height: 52dvh; overflow-y: auto; scrollbar-width: thin;
  padding: var(--space-3) var(--space-5) var(--space-5);
}
#hud .bow-section { display: flex; flex-direction: column; gap: var(--space-3); }
#hud .bow-section + .bow-section { margin-top: var(--space-5); }
#hud .bow-section-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4);
}
#hud .bow-section-title { color: var(--title); font-size: var(--font-m); font-weight: 600; }
#hud .bow-section-count { color: var(--muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
#hud .bow-section-description { color: var(--muted); font-size: var(--font-xs); line-height: 1.5; }
#hud .bow-empty {
  padding: var(--space-5); border-radius: var(--radius-panel);
  background: var(--surface-1); color: var(--muted); text-align: center; line-height: 1.7;
  font-size: var(--font-s);
}
#hud .bow-list { display: flex; flex-direction: column; gap: var(--space-3); }
#hud .bow-row {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-4); border-radius: var(--radius-panel); background: var(--surface-1);
}
#hud .bow-row.is-selected { background: var(--accent-fill); }
#hud .bow-row-main { display: flex; align-items: center; gap: var(--space-4); }
#hud .bow-row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
#hud .bow-row-name { color: var(--title); font-size: var(--font-m); overflow-wrap: break-word; }
#hud .bow-row.is-selected .bow-row-name { color: var(--accent); }
#hud .bow-row-meta { color: var(--muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
#hud .bow-row.is-critical .bow-row-meta { color: var(--danger); }
#hud .bow-row-select {
  flex: 1; min-width: 0; padding: 0; border: 0; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
#hud .bow-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
#hud .bow-meter .w-meter-track { height: 6px; border-radius: var(--radius-control); overflow: hidden; }
#hud .bow-swap-row {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-3); border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--muted); font-size: var(--font-xs);
}
#hud .bow-swap-select {
  flex: 1; min-width: 0; padding: var(--space-2) var(--space-3);
  border: 0; border-radius: var(--radius-control);
  background: var(--surface-3); color: var(--title); font: inherit; font-size: var(--font-xs);
}
#hud .bow-grant-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); }
#hud span.bow-btn {
  padding: var(--space-3) var(--space-4); border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--body); font-size: var(--font-s); white-space: nowrap;
}
#hud span.bow-btn:hover { background: var(--surface-3); color: var(--accent-near); }
#hud span.bow-btn-primary { background: var(--accent-fill); color: var(--accent); }
#hud span.bow-btn-primary:hover { background: var(--accent-fill-strong); color: var(--accent-near); }
#hud span.bow-btn-complete.disabled { opacity: 0.72; color: var(--accent-secondary); }
#hud span.bow-btn-quiet { color: var(--muted); }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export type BaseOperationsTab = 'ships' | 'parts' | 'production';

const TAB_ITEMS: readonly (readonly [BaseOperationsTab, string])[] = [
  ['ships', '格納艦艇'],
  ['parts', '部品'],
  ['production', '生産'],
];

const RESOURCE_GRANT_GROUPS: readonly ObjectPickerGroup<ResourceId>[] = [
  { label: '', items: RESOURCE_IDS.map((id) => [id, `${RESOURCES[id].name} (${id})`] as const) },
];

export class BaseOperationsWindow {
  private win: DraggableWindow | null = null;
  private tabBar: TabBar<BaseOperationsTab> | null = null;
  private contentEl: HTMLDivElement | null = null;
  private grantResourcePicker: ObjectPicker<ResourceId> | null = null;
  private currentTab: BaseOperationsTab = 'ships';
  private currentBase: Vessel | null = null;
  // 部品タブが整備対象として見ている格納艦。艦一覧で選ぶか、行の「部品を見る」から決まる。
  private currentVessel: Vessel | null = null;
  // デバッグ用の資源加算が、直前に何をどれだけ足したかの控え。
  private grantResourceId: ResourceId | null = null;
  private grantMass = 0;
  private lastGrantText = '';

  // 格納艦を発進させたことを知らせる。艦を実際に世界へ戻すのは受け手の責務。
  public onLaunchVessel: ((ship: Vessel, base: Vessel) => void) | null = null;
  // 閉じられた(dispose 済み)ことを呼び出し側の管理台帳へ知らせる。ESC・外側クリック・
  // ✕ ボタンのどの経路で閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。排他は overlayManager 自身が持つ。
  public onClipChange: ((clipped: boolean) => void) | null = null;

  // root は window レイヤ、popupRoot は資源選択のポップアップを出す popup レイヤ。
  // tempWindowGroup を渡すと、クリップされていない間だけ排他グループへ参加する一時ウィンドウになる。
  public constructor(
    private readonly root: HTMLElement,
    private readonly popupRoot: HTMLElement,
    private readonly overlayManager: OverlayManager,
    private readonly tempWindowGroup?: string,
  ) {
    ensureStyle();
  }

  public get base(): Vessel | null { return this.currentBase; }
  public get visible(): boolean { return this.win !== null; }
  public get clipped(): boolean { return this.win?.clipped ?? false; }

  // clientX/clientY を左上角として base の操作面を開く。既に開いていれば対象を base へ
  // 差し替えてその位置へ動かし、最前面へ出す。開けるかどうかの判定(接岸の有無など)は
  // 呼び出し側が済ませている前提で、ここでは行わない。
  public open(base: Vessel, clientX: number, clientY: number): void {
    this.currentBase = base;
    this.currentVessel = null;
    this.currentTab = 'ships';
    if (this.win) {
      this.win.moveTo(clientX, clientY);
      this.win.bringToFront();
      this.refresh();
      return;
    }
    this.build(base, clientX, clientY);
  }

  // ウィンドウ外枠・タブ・中身の器を組み、資源選択のポップアップを popup レイヤへ用意する。
  private build(base: Vessel, clientX: number, clientY: number): void {
    const win = new DraggableWindow(
      this.root, clientX, clientY,
      { title: base.name, subtitle: '基地操作' },
      this.overlayManager, this.tempWindowGroup,
    );
    win.onClose = () => {
      this.teardown();
      this.onClose?.();
    };
    win.onClipChange = (clipped) => this.onClipChange?.(clipped);
    this.win = win;

    const body = document.createElement('div');
    body.className = 'bow-body';
    this.tabBar = new TabBar<BaseOperationsTab>(TAB_ITEMS, (tab) => {
      this.currentTab = tab;
      this.refresh();
    });
    this.tabBar.element.classList.add('bow-tabs');
    this.tabBar.element.setAttribute('aria-label', '基地操作の区画');
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'bow-content';
    this.contentEl.setAttribute('role', 'tabpanel');
    body.append(this.tabBar.element, this.contentEl);
    win.body.appendChild(body);

    this.grantResourcePicker = new ObjectPicker<ResourceId>(this.popupRoot, '資源 id', (id) => {
      this.grantResourceId = id;
      this.grantResourcePicker?.setSelected(id);
    }, this.overlayManager);
    this.grantResourcePicker.setGroups(RESOURCE_GRANT_GROUPS);

    this.refresh();
  }

  // target がこのウィンドウの一部かどうか。外側クリック判定に使う。
  public contains(target: Node): boolean {
    return this.win?.contains(target) ?? false;
  }

  // window レイヤ内で最前面にする。
  public bringToFront(): void {
    this.win?.bringToFront();
  }

  // 要求座標をビューポート内へクランプして配置する。
  public moveTo(clientX: number, clientY: number): void {
    this.win?.moveTo(clientX, clientY);
  }

  // ✕ と同じ「破棄して呼び出し側へ通知する」経路。
  public close(): void {
    this.win?.close();
  }

  // DOM ノードと登録したオーバーレイを取り除く。onClose は発火しない。
  public dispose(): void {
    const win = this.win;
    this.teardown();
    win?.dispose();
  }

  // 開いている間だけ持つ資源を捨て、閉じた状態へ戻す。
  private teardown(): void {
    this.grantResourcePicker?.dispose();
    this.grantResourcePicker = null;
    this.win = null;
    this.tabBar = null;
    this.contentEl = null;
    this.currentBase = null;
    this.currentVessel = null;
  }

  // 選択中のタブの中身を組み直し、見出しを現在の在庫数へ合わせる。操作のたびに呼ぶ。
  private refresh(): void {
    const base = this.currentBase;
    const content = this.contentEl;
    if (!base || !content || !this.win || !this.tabBar) return;

    this.win.syncHeader(base.name, `在庫 ${base.baseState!.resources.storedIds.length} 種`);
    this.tabBar.setSelected(this.currentTab);
    content.innerHTML = '';
    switch (this.currentTab) {
      case 'ships': content.appendChild(this.buildShipsSection(base)); break;
      case 'parts': content.appendChild(this.buildPartsSection(base)); break;
      case 'production': content.appendChild(this.buildProductionSection(base)); break;
    }
    this.win.reclamp();
  }

  // 表題・右肩の件数・任意の説明文からなる小見出しを組む。説明文が空なら行ごと出さない。
  private buildSectionHeader(titleText: string, descriptionText: string, countText: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bow-section-head';
    const title = document.createElement('span');
    title.className = 'bow-section-title';
    title.textContent = titleText;
    const count = document.createElement('span');
    count.className = 'bow-section-count';
    count.textContent = countText;
    section.append(title, count);
    const wrap = document.createElement('div');
    wrap.className = 'bow-section';
    wrap.appendChild(section);
    if (descriptionText) {
      const description = document.createElement('span');
      description.className = 'bow-section-description';
      description.textContent = descriptionText;
      wrap.appendChild(description);
    }
    return wrap;
  }

  // ─── 格納艦艇タブ ───────────────────────────────────────────
  private buildShipsSection(base: Vessel): HTMLElement {
    const ships = base.baseState!.dockedVessels;
    const frag = document.createElement('section');
    frag.className = 'bow-section';
    frag.appendChild(this.buildSectionHeader(
      '格納艦艇',
      '発進する艦を選ぶか、部品タブで搭載部品を確認します。',
      `${ships.length} / ${base.dockCapacity} 隻`,
    ));
    if (ships.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bow-empty';
      empty.textContent = '格納艦艇はありません。ランデブー後に収容してください。';
      frag.appendChild(empty);
      return frag;
    }
    const list = document.createElement('div');
    list.className = 'bow-list';
    list.setAttribute('role', 'list');
    ships.forEach((ship, i) => list.appendChild(this.buildShipRow(ship, i)));
    frag.appendChild(list);
    return frag;
  }

  // 格納艦1隻の行。名前とHPを見せ、選択・発進・部品タブへの移動を提供する。
  private buildShipRow(entry: DockedVesselEntry, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bow-row';
    row.setAttribute('role', 'listitem');
    const selected = this.currentVessel?.id === entry.id;
    row.classList.toggle('is-selected', selected);
    const hpRatio = entry.maxHp > 0 ? entry.hp / entry.maxHp : 0;
    row.classList.toggle('is-critical', hpRatio <= 0.3);

    const main = document.createElement('div');
    main.className = 'bow-row-main';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'bow-row-select';
    select.setAttribute('aria-pressed', String(selected));
    select.addEventListener('click', () => {
      this.currentVessel = entry.vessel;
      this.refresh();
    });
    const info = document.createElement('div');
    info.className = 'bow-row-info';
    const name = document.createElement('span');
    name.className = 'bow-row-name';
    name.textContent = `${entry.name || `艦 #${index + 1}`} [ドック ${entry.slotIndex + 1}]`;
    const hp = document.createElement('span');
    hp.className = 'bow-row-meta';
    hp.textContent = `HP ${Math.round(entry.hp ?? 0).toLocaleString()} / ${Math.round(entry.maxHp ?? 0).toLocaleString()}`;
    info.append(name, hp);
    select.appendChild(info);
    main.appendChild(select);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'bow-actions';
    const canOperate = hasCorePart(entry.vessel);
    const launchBtn = new Button(canOperate ? '発進' : '発進(操作系なし)', () => this.handleLaunch(index));
    launchBtn.element.classList.add('bow-btn', 'bow-btn-primary');
    launchBtn.setEnabled(canOperate);
    const inspectBtn = new Button('部品を見る', () => this.handleInspect(index));
    inspectBtn.element.classList.add('bow-btn', 'bow-btn-quiet');
    actions.append(launchBtn.element, inspectBtn.element);
    row.appendChild(actions);
    return row;
  }

  // ─── 部品タブ ───────────────────────────────────────────
  // 搭載部品(修理・補給・換装)と倉庫の在庫を縦に並べる。倉庫は基地の持ち物なので、
  // 格納艦が居なくても出す。
  private buildPartsSection(base: Vessel): HTMLElement {
    const ship = this.currentVessel;
    const shipData = (ship ? base.baseState!.dockedVessels.find((s) => s.id === ship.id) : undefined)
      ?? base.baseState!.dockedVessels[0]
      ?? null;

    const frag = document.createElement('section');
    frag.className = 'bow-section';
    frag.appendChild(this.buildSectionHeader(
      '搭載部品',
      shipData ? `整備対象 ${shipData.name || '名称未設定の艦'}` : '',
      `倉庫 ${base.baseState!.inventory.length} 点`,
    ));
    if (shipData) {
      frag.appendChild(this.buildRepairAllRow(base, shipData));
      const list = document.createElement('div');
      list.className = 'bow-list';
      list.setAttribute('role', 'list');
      shipData.parts.forEach((part, i) => list.appendChild(this.buildInstalledPartRow(base, shipData, part, i)));
      frag.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'bow-empty';
      empty.textContent = '格納艦がありません。収容すると、ここで整備できます。';
      frag.appendChild(empty);
    }

    const warehouse = document.createElement('section');
    warehouse.className = 'bow-section';
    warehouse.appendChild(this.buildSectionHeader('倉庫', '', `${base.baseState!.inventory.length} 点`));
    warehouse.appendChild(this.buildWarehouseList(base));
    frag.appendChild(warehouse);
    return frag;
  }

  // 艦の全部品をまとめて修理するボタンの行。
  private buildRepairAllRow(base: Vessel, shipData: DockedVesselEntry): HTMLElement {
    const damaged = (shipData.parts as AnyPart[]).filter((p) => p.hp < p.maxHp);
    const request = repairAllBlueprintOf(damaged);
    const row = document.createElement('div');
    row.className = 'bow-actions';
    const btn = new Button(
      damaged.length > 0 ? `全部品を修理 · ${this.formatCost(request)}` : '全部品は正常',
      () => this.handleRepairAll(shipData.id),
    );
    btn.element.classList.add('bow-btn');
    btn.element.classList.toggle('bow-btn-complete', damaged.length === 0);
    btn.setEnabled(damaged.length > 0 && this.canAfford(base, request));
    row.appendChild(btn.element);
    return row;
  }

  // 搭載部品1件の行。同じ type の在庫があれば換装欄を、推進剤タンクなら補給ボタンを添える。
  private buildInstalledPartRow(base: Vessel, shipData: DockedVesselEntry, part: Part, index: number): HTMLElement {
    const hpRatio = part.maxHp > 0 ? Math.max(0, Math.min(1, part.hp / part.maxHp)) : 0;
    const repairRequest = repairBlueprintOf(part as AnyPart);
    const damaged = part.hp < part.maxHp;

    const row = document.createElement('div');
    row.className = 'bow-row';
    row.setAttribute('role', 'listitem');
    const main = document.createElement('div');
    main.className = 'bow-row-main';
    const info = document.createElement('div');
    info.className = 'bow-row-info';
    const name = document.createElement('span');
    name.className = 'bow-row-name';
    name.textContent = part.name;
    const meta = document.createElement('span');
    meta.className = 'bow-row-meta';
    meta.textContent = formatPartMeta(part);
    info.append(name, meta);
    main.appendChild(info);

    const meter = new Meter();
    meter.element.classList.add('bow-meter');
    meter.setRatio(hpRatio);
    meter.setDanger(hpRatio <= 0.3);
    meter.setLabel(`${Math.round(part.hp)}/${part.maxHp}`);
    meter.element.setAttribute('role', 'progressbar');
    meter.element.setAttribute('aria-label', `${part.name}の耐久`);
    meter.element.setAttribute('aria-valuemin', '0');
    meter.element.setAttribute('aria-valuemax', String(part.maxHp));
    meter.element.setAttribute('aria-valuenow', String(Math.round(part.hp)));
    main.appendChild(meter.element);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'bow-actions';
    const repairBtn = new Button(
      damaged ? `修理 · ${this.formatCost(repairRequest)}` : '正常',
      () => this.handleRepairPart(shipData.id, index),
    );
    repairBtn.element.classList.add('bow-btn');
    repairBtn.element.classList.toggle('bow-btn-complete', !damaged);
    repairBtn.setEnabled(damaged && this.canAfford(base, repairRequest));
    actions.appendChild(repairBtn.element);
    if (isPropellantTankPart(part)) {
      actions.appendChild(this.buildRefuelButton(
        base, part, () => this.handleRefuelInstalled(shipData.id, index)));
    }
    row.appendChild(actions);

    const candidates = base.baseState!.inventory.filter((inv) => inv.type === part.type);
    if (candidates.length > 0) row.appendChild(this.buildSwapRow(shipData.id, index, candidates));
    return row;
  }

  // 換装候補の選択欄と換装ボタンの行。
  private buildSwapRow(shipId: string, partIdx: number, candidates: readonly AnyPart[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bow-swap-row';
    const label = document.createElement('span');
    label.textContent = '換装候補';
    row.appendChild(label);
    const select = document.createElement('select');
    select.className = 'bow-swap-select';
    select.setAttribute('aria-label', '換装候補の部品');
    for (const candidate of candidates) {
      const option = document.createElement('option');
      option.value = candidate.id;
      option.textContent = `${candidate.name} · 耐久 ${Math.round(candidate.hp)}/${candidate.maxHp}`;
      select.appendChild(option);
    }
    row.appendChild(select);
    const swapBtn = new Button('換装', () => this.handleSwapPart(shipId, partIdx, select.value));
    swapBtn.element.classList.add('bow-btn', 'bow-btn-primary');
    row.appendChild(swapBtn.element);
    return row;
  }

  // 倉庫にある在庫部品の一覧。推進剤タンクならその場での補給を提供する。
  private buildWarehouseList(base: Vessel): HTMLElement {
    const inventory = base.baseState!.inventory;
    if (inventory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bow-empty';
      empty.textContent = '倉庫は空です。生産タブで部品を作るか、艦から部品を外すと入ります。';
      return empty;
    }
    const list = document.createElement('div');
    list.className = 'bow-list';
    list.setAttribute('role', 'list');
    for (const part of inventory) {
      const row = document.createElement('div');
      row.className = 'bow-row';
      row.setAttribute('role', 'listitem');
      const main = document.createElement('div');
      main.className = 'bow-row-main';
      const info = document.createElement('div');
      info.className = 'bow-row-info';
      const name = document.createElement('span');
      name.className = 'bow-row-name';
      name.textContent = part.name;
      const meta = document.createElement('span');
      meta.className = 'bow-row-meta';
      meta.textContent = `${formatPartMeta(part)} · 耐久 ${Math.round(part.hp)}/${part.maxHp}`;
      info.append(name, meta);
      main.appendChild(info);
      row.appendChild(main);
      if (isPropellantTankPart(part)) {
        const actions = document.createElement('div');
        actions.className = 'bow-actions';
        actions.appendChild(this.buildRefuelButton(base, part, () => this.handleRefuelInventory(part.id)));
        row.appendChild(actions);
      }
      list.appendChild(row);
    }
    return list;
  }

  // 推進剤タンク用の補給ボタンを作る。ラベルにどの推進剤かを添える。
  private buildRefuelButton(base: Vessel, tank: PropellantTankPart, onClick: () => void): HTMLElement {
    const missing = Math.max(0, propellantTankCapacity(tank.propellant, tank.volume) - tank.fuel);
    const request = refuelBlueprintOf(tank.propellant, missing);
    const propellantName = TANK_MATERIALS[tank.propellant].name;
    const btn = new Button(
      missing > 0 ? `${propellantName}補給 · ${this.formatCost(request)}` : `${propellantName}は満タン`, onClick);
    btn.element.classList.add('bow-btn');
    btn.element.classList.toggle('bow-btn-complete', missing <= 0);
    btn.setEnabled(missing > 0 && this.canAfford(base, request));
    return btn.element;
  }

  // ─── 生産タブ ───────────────────────────────────────────
  private buildProductionSection(base: Vessel): HTMLElement {
    const frag = document.createElement('section');
    frag.className = 'bow-section';
    frag.appendChild(this.buildPartProductionSection(base));
    frag.appendChild(this.buildInventorySection(base));
    frag.appendChild(this.buildGrantSection(base));
    return frag;
  }

  // 搭載要素を1つだけ作って倉庫へ入れる。見本は既定の設計が実際に積んでいる要素そのものなので、
  // 換装しても推力や耐久の桁が既定艦とずれない。
  private buildPartProductionSection(base: Vessel): HTMLElement {
    const samples = producibleParts();
    const frag = document.createElement('section');
    frag.className = 'bow-section';
    frag.appendChild(this.buildSectionHeader(
      '部品の生産', '搭載要素を1つ作り、この基地の倉庫へ入れます。', `${samples.length} 種`));
    const list = document.createElement('div');
    list.className = 'bow-list';
    for (const sample of samples) {
      const request = partProductionBlueprintOf(sample);
      const row = document.createElement('div');
      row.className = 'bow-row';
      const main = document.createElement('div');
      main.className = 'bow-row-main';
      const info = document.createElement('div');
      info.className = 'bow-row-info';
      const name = document.createElement('span');
      name.className = 'bow-row-name';
      name.textContent = sample.name;
      const meta = document.createElement('span');
      meta.className = 'bow-row-meta';
      meta.textContent = `${formatPartMeta(sample)} · ${this.formatCost(request)}`;
      info.append(name, meta);
      main.appendChild(info);
      row.appendChild(main);
      const actions = document.createElement('div');
      actions.className = 'bow-actions';
      const btn = new Button('生産して倉庫へ', () => this.handleProducePart(sample));
      btn.element.classList.add('bow-btn', 'bow-btn-primary');
      btn.setEnabled(this.canAfford(base, request));
      actions.appendChild(btn.element);
      row.appendChild(actions);
      list.appendChild(row);
    }
    frag.appendChild(list);
    return frag;
  }

  // この基地が保有する資源を、種別ごとに1行ずつ並べる。
  private buildInventorySection(base: Vessel): HTMLElement {
    const ledger = base.baseState!.resources;
    const ids = ledger.storedIds;
    const frag = document.createElement('section');
    frag.className = 'bow-section';
    frag.appendChild(this.buildSectionHeader('在庫', '', `${ids.length} 種`));
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bow-empty';
      empty.textContent = '在庫は空です。';
      frag.appendChild(empty);
      return frag;
    }
    const list = document.createElement('div');
    list.className = 'bow-list';
    for (const id of ids) {
      const line = document.createElement('div');
      line.className = 'bow-row bow-row-meta';
      line.textContent = formatResourceAmount(id, ledger.amountOf(id));
      list.appendChild(line);
    }
    frag.appendChild(list);
    return frag;
  }

  // 資源をゲーム内で確保する手段(月面の採掘・敵のドロップ)は、この段階より後にある。
  // 生産が最初に動くための足場であり、着陸と採掘が入った時点で削除する。
  private buildGrantSection(base: Vessel): HTMLElement {
    const frag = document.createElement('section');
    frag.className = 'bow-section';
    frag.appendChild(this.buildSectionHeader(
      '資源の加算(デバッグ)', '資源を選び、質量を指定して、この基地の在庫へ加算します。', ''));
    const row = document.createElement('div');
    row.className = 'bow-grant-row';
    const massInput = new ValueInput(
      { type: 'number', min: 0, placeholder: 'kg' }, (value) => { this.grantMass = Number(value); });
    const btn = new Button('加算', () => this.handleGrantResource(base));
    btn.element.classList.add('bow-btn', 'bow-btn-primary');
    if (this.grantResourcePicker) row.appendChild(this.grantResourcePicker.element);
    row.append(massInput.element, btn.element);
    frag.appendChild(row);
    const result = document.createElement('span');
    result.className = 'bow-section-description';
    result.textContent = this.lastGrantText;
    frag.appendChild(result);
    return frag;
  }

  // ─── 資源の勘定 ───────────────────────────────────────────
  // 何が足りないか。空配列なら要求を満たしている。
  private shortfall(base: Vessel, request: ProducibilityBlueprint): readonly Requirement[] {
    return producibility(request, base.baseState!.resources, baseFacilities(base), basePowerAvailable(base));
  }

  // 要求を資源だけで満たせるか。
  private canAfford(base: Vessel, request: ProducibilityBlueprint): boolean {
    return this.shortfall(base, request).length === 0;
  }

  // 資源を引く。足りなければ何も引かずに false を返す。
  private spend(base: Vessel, request: ProducibilityBlueprint): boolean {
    if (!this.canAfford(base, request)) return false;
    return consumeProductionResources(request, base.baseState!.resources);
  }

  // 要求のうち資源だけを「アルミ 12.0 kg・電子機器 3.0 kg」の形に畳む。ボタンの但し書き用。
  private formatCost(request: ProducibilityBlueprint): string {
    const demand = productionResourceDemand(request, this.currentBase!.baseState!.resources);
    const parts = [...demand].map(([id, mass]) => formatResourceAmount(id, mass));
    return parts.length === 0 ? '資源なし' : parts.join('・');
  }

  // ─── 操作 ───────────────────────────────────────────────
  private handleLaunch(index: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels[index];
    if (!shipData) return;
    this.onLaunchVessel?.(shipData.vessel, base);
    if (this.currentVessel === shipData.vessel) this.currentVessel = null;
    this.refresh();
  }

  // 指定の格納艦を整備対象に据え、部品タブへ移る。
  private handleInspect(index: number): void {
    const shipData = this.currentBase?.baseState!.dockedVessels[index];
    if (!shipData) return;
    this.currentVessel = shipData.vessel;
    this.currentTab = 'parts';
    this.refresh();
  }

  private handleProducePart(sample: AnyPart): void {
    const base = this.currentBase;
    if (!base) return;
    if (!this.spend(base, partProductionBlueprintOf(sample))) return;
    base.baseState!.inventory.push(buildPartFrom(sample));
    this.refresh();
  }

  private handleGrantResource(base: Vessel): void {
    const id = this.grantResourceId;
    const mass = this.grantMass;
    if (id === null || !Number.isFinite(mass) || mass <= 0) {
      this.lastGrantText = `加算できません: ${id ?? '(未選択)'} ${mass}`;
      this.refresh();
      return;
    }
    base.baseState!.resources.add(id, mass);
    this.lastGrantText = `加算しました: ${formatResourceAmount(id, mass)}`;
    this.refresh();
  }

  private handleRepairPart(shipId: string, partIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    if (!shipData) return;
    const part: Part | undefined = shipData.parts[partIdx];
    if (!part || part.hp >= part.maxHp) return;
    if (!this.spend(base, repairBlueprintOf(part as AnyPart))) return;
    part.hp = part.maxHp;
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRepairAll(shipId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    if (!shipData) return;
    const parts = shipData.parts;
    const damaged = (parts as AnyPart[]).filter((p) => p.hp < p.maxHp);
    if (damaged.length === 0) return;
    if (!this.spend(base, repairAllBlueprintOf(damaged))) return;
    parts.forEach((p) => { p.hp = p.maxHp; });
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  // 格納中は shipData.parts が艦本体の parts 配列と同一参照なので、修理は艦へ直接反映される。
  // hp/maxHp の集計スナップショットだけは別に持っているので、艦一覧の表示用にここで揃える。
  private syncDockedSnapshot(shipData: DockedVesselEntry): void {
    shipData.vessel.refreshFromParts();
    shipData.hp = shipData.vessel.hp;
    shipData.maxHp = shipData.vessel.maxHp;
  }

  // 搭載部品を、選択中の倉庫在庫(同じ type)と入れ替える。外した部品は倉庫へ戻す。
  // shipData.parts は艦の parts と同一参照なので、splice による差し替えは性能集計へ即反映される。
  private handleSwapPart(shipId: string, partIdx: number, invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    const installed = shipData?.parts[partIdx];
    if (!shipData || !installed) return;
    const invIdx = base.baseState!.inventory.findIndex((p) => p.id === invId);
    const incoming = base.baseState!.inventory[invIdx];
    if (!incoming || incoming.type !== installed.type) return;
    shipData.parts.splice(partIdx, 1, incoming);
    base.baseState!.inventory.splice(invIdx, 1, installed as AnyPart);
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRefuelInstalled(shipId: string, partIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    const part = shipData?.parts[partIdx];
    if (!part || !isPropellantTankPart(part)) return;
    this.refuelTank(base, part);
    this.refresh();
  }

  private handleRefuelInventory(invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const part = base.baseState!.inventory.find((p) => p.id === invId);
    if (!part || !isPropellantTankPart(part)) return;
    this.refuelTank(base, part);
    this.refresh();
  }

  private refuelTank(base: Vessel, tank: PropellantTankPart): void {
    const capacity = propellantTankCapacity(tank.propellant, tank.volume);
    const missing = Math.max(0, capacity - tank.fuel);
    if (missing <= 0) return;
    if (!this.spend(base, refuelBlueprintOf(tank.propellant, missing))) return;
    tank.fuel = capacity;
  }
}
