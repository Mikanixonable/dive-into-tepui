import type { Base, DockedVesselEntry } from '../../dynamic/dynamic-entity/base';
import type { AnyPart, Part, RcsTankPart } from '../../dynamic/dynamic-entity/parts';
import { Button, Meter } from '../widgets';
import type { BasePanel } from './base-view';
import {
  buildFeeButton, buildSectionHeader, formatPartMeta, isRcsTank, REPAIR_COST_PER_HP, refuelCost, sellPrice,
  styleDockBtn,
} from './base-view-shared';

// 基地パネルの「部品」タブ: 搭載部品(修理・換装・補給)と倉庫(在庫確認・売却・補給)を扱う。
export class PartsTabController {
  public constructor(private readonly panel: BasePanel) {}

  // 搭載部品と倉庫を左右に並べ、同じ種類の部品を見比べながら換装先を選べるようにする。
  public build(base: Base): HTMLElement {
    // 選択艦がなければ最初の艦を表示。倉庫は基地の持ち物なので、格納艦が居なくても出す。
    const ship = this.panel.vessel;
    const shipData = (ship ? base.baseState.dockedVessels.find((s) => s.id === ship.id) : undefined)
      ?? base.baseState.dockedVessels[0]
      ?? null;

    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(buildSectionHeader(
      '部品と倉庫',
      '選択艦を修理・補給し、同じ種類の倉庫部品へ換装できます。',
      `${base.baseState.inventory.length} 点を保管`,
    ));
    if (shipData) frag.appendChild(this.buildRepairAllHeader(base, shipData));

    const columns = document.createElement('div');
    columns.className = 'dock-parts-columns';

    const installedCol = document.createElement('div');
    installedCol.className = 'dock-parts-col';
    const installedTitle = document.createElement('h3');
    installedTitle.className = 'dock-col-title';
    installedTitle.textContent = '搭載部品';
    installedCol.appendChild(installedTitle);
    if (shipData) {
      const list = document.createElement('div');
      list.className = 'dock-part-list';
      list.setAttribute('role', 'list');
      for (const [i, p] of shipData.parts.entries()) list.appendChild(this.buildInstalledPartRow(base, shipData, p, i));
      installedCol.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '格納艦がありません。ランデブー後に収容すると、ここで整備できます。';
      installedCol.appendChild(empty);
    }
    columns.appendChild(installedCol);

    const warehouseCol = document.createElement('div');
    warehouseCol.className = 'dock-parts-col';
    const warehouseTitle = document.createElement('h3');
    warehouseTitle.className = 'dock-col-title';
    warehouseTitle.textContent = '倉庫';
    warehouseCol.appendChild(warehouseTitle);
    warehouseCol.appendChild(this.buildWarehouseList(base));
    columns.appendChild(warehouseCol);

    frag.appendChild(columns);
    return frag;
  }

  // 艦の全部品をまとめて修理するボタンの行。
  private buildRepairAllHeader(base: Base, shipData: DockedVesselEntry): HTMLElement {
    // 全部品ぶんの修理費用を合算する。
    const totalRepairCost = shipData.parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    // 整備対象の艦名を示すラベル。
    const row = document.createElement('div');
    row.className = 'dock-parts-header dock-focus-panel';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.append('整備対象 ');
    const shipName = document.createElement('strong');
    shipName.textContent = shipData.name || '名称未設定の艦';
    label.appendChild(shipName);
    row.appendChild(label);
    // 合算費用でまとめて修理するボタン。
    row.appendChild(buildFeeButton(
      this.panel.freeProcurement, base.baseState.money, totalRepairCost,
      '全部品を修理', '全部品は正常', () => this.handleRepairAll(base, shipData.id),
    ));
    return row;
  }

  // 搭載部品1件の行を作る。同じ type の在庫があれば換装欄を、rcs_tank なら補給ボタンを添える。
  private buildInstalledPartRow(base: Base, shipData: DockedVesselEntry, p: Part, i: number): HTMLElement {
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    const repairCost = (p.maxHp - p.hp) * REPAIR_COST_PER_HP;

    const row = document.createElement('div');
    row.className = 'dock-part-row';
    row.setAttribute('role', 'listitem');
    const main = document.createElement('div');
    main.className = 'dock-part-row-main';
    main.appendChild(this.buildPartInfo(p));

    const meter = new Meter();
    meter.element.classList.add('dock-part-hp-meter');
    meter.setRatio(hpPct / 100);
    // 耐久が3割以下になったら Meter の危険表示(DANGER)を点灯する。
    meter.setDanger(hpPct <= 30);
    meter.setLabel(`${Math.round(p.hp)}/${p.maxHp}`);
    meter.element.setAttribute('role', 'progressbar');
    meter.element.setAttribute('aria-label', `${p.name}の耐久`);
    meter.element.setAttribute('aria-valuemin', '0');
    meter.element.setAttribute('aria-valuemax', String(p.maxHp));
    meter.element.setAttribute('aria-valuenow', String(Math.round(p.hp)));
    main.appendChild(meter.element);

    const actions = document.createElement('div');
    actions.className = 'dock-part-actions';
    actions.appendChild(buildFeeButton(
      this.panel.freeProcurement, base.baseState.money, repairCost,
      '修理', '正常', () => this.handleRepairPart(base, shipData.id, i),
    ));
    if (isRcsTank(p)) {
      actions.appendChild(this.buildRefuelButton(base, p, () => this.handleRefuelInstalled(base, shipData.id, i)));
    }
    main.appendChild(actions);
    row.appendChild(main);

    const candidates = base.baseState.inventory.filter((inv) => inv.type === p.type);
    if (candidates.length > 0) row.appendChild(this.buildSwapRow(base, shipData.id, i, candidates));
    return row;
  }

  // 部品名と種別ラベルをまとめた情報ブロックを作る。
  private buildPartInfo(part: Part): HTMLElement {
    const info = document.createElement('div');
    info.className = 'dock-part-info';
    // 部品名。
    const name = document.createElement('span');
    name.className = 'dock-part-name';
    name.textContent = part.name;
    // 種別ラベル(rcs_tank なら燃料残量も添える)。
    const type = document.createElement('span');
    type.className = 'dock-part-type';
    type.textContent = formatPartMeta(part);
    info.append(name, type);
    return info;
  }

  // 換装候補の選択欄(<select>)と換装ボタンの行。
  private buildSwapRow(base: Base, shipId: string, partIdx: number, candidates: readonly AnyPart[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-part-swap-row';
    const label = document.createElement('span');
    label.textContent = '換装候補';
    row.appendChild(label);
    // 換装先の在庫を選ぶ <select>。
    const select = document.createElement('select');
    select.className = 'dock-part-swap-select';
    for (const c of candidates) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} · 耐久 ${Math.round(c.hp)}/${c.maxHp}`;
      select.appendChild(opt);
    }
    row.appendChild(select);
    // 選択中の在庫へ換装するボタン。
    const swapBtn = new Button('換装', () => this.handleSwapPart(base, shipId, partIdx, select.value));
    styleDockBtn(swapBtn.element, 'primary');
    row.appendChild(swapBtn.element);
    return row;
  }

  // 倉庫にある在庫部品の一覧。売却と、rcs_tank ならその場での補給を提供する。
  private buildWarehouseList(base: Base): HTMLElement {
    const inventory = base.baseState.inventory;
    if (inventory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '倉庫は空です。ショップで購入するか、艦から部品を外すと入ります。';
      return empty;
    }
    const list = document.createElement('div');
    list.className = 'dock-part-list';
    list.setAttribute('role', 'list');
    for (const p of inventory) {
      // 部品情報と耐久表示。
      const row = document.createElement('div');
      row.className = 'dock-part-row';
      row.setAttribute('role', 'listitem');
      const main = document.createElement('div');
      main.className = 'dock-part-row-main dock-warehouse-row-main';
      main.appendChild(this.buildPartInfo(p));

      const hpText = document.createElement('span');
      hpText.className = 'dock-part-hp-text';
      hpText.textContent = `耐久 ${Math.round(p.hp)}/${p.maxHp}`;
      main.appendChild(hpText);

      // rcs_tank なら補給ボタン、共通で売却ボタンを添える。
      const actions = document.createElement('div');
      actions.className = 'dock-part-actions';
      if (p.type === 'rcs_tank') {
        actions.appendChild(this.buildRefuelButton(base, p, () => this.handleRefuelInventory(base, p.id)));
      }
      const price = sellPrice(p);
      const sellBtn = new Button(`売却 · ${price.toLocaleString()} Cr`, () => this.handleSellPart(base, p.id));
      styleDockBtn(sellBtn.element, 'quiet');
      actions.appendChild(sellBtn.element);
      main.appendChild(actions);
      row.appendChild(main);
      list.appendChild(row);
    }
    return list;
  }

  // rcs_tank 用の補給ボタンを作る。
  private buildRefuelButton(base: Base, tank: RcsTankPart, onClick: () => void): HTMLElement {
    const cost = refuelCost(tank);
    return buildFeeButton(this.panel.freeProcurement, base.baseState.money, cost, '燃料補給', '燃料は満タン', onClick);
  }

  // 艦の1部品を修理する。資金不足なら何もしない。
  private handleRepairPart(base: Base, shipId: string, partIdx: number): void {
    // 対象の艦と部品を特定する。
    const shipData = base.baseState.dockedVessels.find((s) => s.id === shipId);
    if (!shipData) return;

    const part: Part | undefined = shipData.parts[partIdx];
    if (!part) return;
    const cost = (part.maxHp - part.hp) * REPAIR_COST_PER_HP;
    if (!this.panel.freeProcurement && base.baseState.money < cost) return;

    // 費用を払って全快させる。
    if (!this.panel.freeProcurement) base.baseState.money -= cost;
    part.hp = part.maxHp;
    this.syncDockedSnapshot(shipData);
    this.panel.refresh();
  }

  // 艦の全部品をまとめて修理する。資金不足なら何もしない。
  private handleRepairAll(base: Base, shipId: string): void {
    const shipData = base.baseState.dockedVessels.find((s) => s.id === shipId);
    if (!shipData) return;

    // 全部品ぶんの費用を合算してから、資金を確認する。
    const parts = shipData.parts;
    const totalCost = parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    if (!this.panel.freeProcurement && base.baseState.money < totalCost) return;

    // 費用を払って全部品を全快させる。
    if (!this.panel.freeProcurement) base.baseState.money -= totalCost;
    for (const p of parts) p.hp = p.maxHp;
    this.syncDockedSnapshot(shipData);
    this.panel.refresh();
  }

  // 格納中は shipData.parts が艦本体の parts 配列と同一参照なので、修理は艦へ直接反映される。
  // hp/maxHp の集計スナップショットだけは別に持っているので、艦一覧タブの表示用にここで揃える。
  private syncDockedSnapshot(shipData: DockedVesselEntry): void {
    shipData.player.refreshFromParts();
    shipData.hp = shipData.player.hp;
    shipData.maxHp = shipData.player.maxHp;
  }

  // 搭載部品を、選択中の倉庫在庫(同じ type)と入れ替える。外した部品は倉庫へ戻す。
  // shipData.parts は player.parts と同一参照なので、splice による差し替えは艦の性能集計へ即反映される。
  private handleSwapPart(base: Base, shipId: string, partIdx: number, invId: string): void {
    // 対象の艦の搭載部品と、換装先の在庫を特定する。
    const shipData = base.baseState.dockedVessels.find((s) => s.id === shipId);
    const installed = shipData?.parts[partIdx];
    if (!shipData || !installed) return;

    const invIdx = base.baseState.inventory.findIndex((p) => p.id === invId);
    const incoming = base.baseState.inventory[invIdx];
    if (!incoming || incoming.type !== installed.type) return;

    // 搭載側と倉庫側を互いに入れ替える。
    shipData.parts.splice(partIdx, 1, incoming);
    base.baseState.inventory.splice(invIdx, 1, installed as AnyPart);

    this.syncDockedSnapshot(shipData);
    this.panel.refresh();
  }

  // 搭載中の RCS タンクへ補給する。
  private handleRefuelInstalled(base: Base, shipId: string, partIdx: number): void {
    const shipData = base.baseState.dockedVessels.find((s) => s.id === shipId);
    const part = shipData?.parts[partIdx];
    if (!part || !isRcsTank(part)) return;
    this.refuelTank(base, part);
    this.panel.refresh();
  }

  // 倉庫にある RCS タンクへ補給する。
  private handleRefuelInventory(base: Base, invId: string): void {
    const part = base.baseState.inventory.find((p) => p.id === invId);
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part);
    this.panel.refresh();
  }

  // RCS タンクを満タンまで補給し、費用を差し引く。資金不足なら何もしない。
  private refuelTank(base: Base, tank: RcsTankPart): void {
    const cost = refuelCost(tank);
    if (cost <= 0) return;
    if (!this.panel.freeProcurement && base.baseState.money < cost) return;
    if (!this.panel.freeProcurement) base.baseState.money -= cost;
    tank.fuel = tank.maxFuel;
  }

  // 倉庫の部品を売却し、代金を受け取る。
  private handleSellPart(base: Base, invId: string): void {
    const idx = base.baseState.inventory.findIndex((p) => p.id === invId);
    const part = base.baseState.inventory[idx];
    if (idx < 0 || !part) return;

    base.baseState.money += sellPrice(part);
    base.baseState.inventory.splice(idx, 1);
    this.panel.refresh();
  }
}
