// ドックビュー: 基地に接岸した際に開くフルスクリーンUI。
// 格納されている船の一覧、部品の確認・修理・換装、ショップを提供する。
import type { Base, DockedShipEntry } from '../game-entity/base';
import type { Player } from '../player/player';
import type { AnyPart, Part, PartType, RcsTankPart } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';
import * as C from '../const';
import { Button, CloseButton, Meter, TabBar } from './widgets';
import { MQ_COMPACT } from './breakpoints';

const STYLE = `
/* 戦闘・マップと対等な全画面ビュー。背後の 3D は描画自体が止まるので、
   透過させず不透明な地の色で塗り切る。 */
#dock-view.dock-view-overlay {
  position: fixed; inset: 0;
  display: flex;
  background: var(--bg);
  font-family: var(--font-family);
  pointer-events: auto;
  /* 右上のビューバッジは全ビュー共通の枠なのでドック中も残る。その帯を避けて中身を始める。 */
  padding-top: var(--space-6);
}
#dock-view .dock-panel {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
#dock-view .dock-header {
  display: flex; align-items: center; gap: var(--space-5);
  padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--edge);
  flex: 0 0 auto;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-title {
  font-size: var(--font-xl); font-weight: 700; letter-spacing: 0.12em;
  color: var(--accent); flex: 0 0 auto;
}
#dock-view .dock-tabs { flex: 1; }
#dock-view .dock-status-bar {
  padding: var(--space-3) var(--space-6); border-bottom: 1px solid var(--edge);
  font-size: var(--font-m); color: var(--text-dim); flex: 0 0 auto;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-body {
  flex: 1 1 0; overflow-y: auto; padding: var(--space-5) var(--space-6);
  scrollbar-width: thin;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-empty { color: var(--text-dim); padding: var(--space-6); text-align: center; line-height: 1.8; }
/* Ships tab */
#dock-view .dock-ship-list { display: flex; flex-direction: column; gap: var(--space-4); }
#dock-view .dock-ship-row {
  display: flex; align-items: center; gap: var(--space-5); padding: var(--space-5) var(--space-5);
  border: 1px solid var(--edge); border-radius: var(--radius-m); cursor: pointer;
  transition: border-color var(--transition-fast);
}
#dock-view .dock-ship-row:hover { border-color: var(--accent-soft); }
#dock-view .dock-ship-row.on { border-color: var(--accent); background: var(--accent-fill-weak); }
#dock-view .dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#dock-view .dock-ship-name { font-size: var(--font-l); }
#dock-view .dock-ship-hp { font-size: var(--font-s); color: var(--text-dim); }
#dock-view .dock-ship-actions { display: flex; gap: var(--space-3); }
/* Parts tab */
#dock-view .dock-parts-header {
  display: flex; align-items: center; gap: var(--space-5); margin-bottom: var(--space-5);
  padding-bottom: var(--space-4); border-bottom: 1px solid var(--edge);
}
#dock-view .dock-ship-label { font-size: var(--font-m); color: var(--text-dim); flex: 1; }
#dock-view .dock-part-list { display: flex; flex-direction: column; gap: var(--space-3); }
#dock-view .dock-part-row {
  display: grid; grid-template-columns: 1fr minmax(80px, 120px) minmax(40px, 60px) auto;
  align-items: center; gap: var(--space-5); padding: var(--space-3) var(--space-5);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
}
#dock-view .dock-part-info { display: flex; flex-direction: column; gap: var(--space-1); }
#dock-view .dock-part-name { font-size: var(--font-m); }
#dock-view .dock-part-type { font-size: var(--font-xs); color: var(--text-dim); }
#dock-view .dock-part-hp-meter .w-meter-track { height: 6px; border-radius: var(--radius-s); }
#dock-view .dock-part-hp-meter .w-meter-fill { border-radius: var(--radius-s); transition: width var(--transition-slow); }
#dock-view .dock-part-hp-text { font-size: var(--font-s); color: var(--text-dim); text-align: right; }
#dock-view .dock-part-row { display: flex; flex-direction: column; gap: var(--space-3); }
#dock-view .dock-part-row-main {
  display: grid; grid-template-columns: 1fr minmax(80px, 120px) minmax(40px, 60px) auto;
  align-items: center; gap: var(--space-5);
}
#dock-view .dock-warehouse-row-main { grid-template-columns: 1fr minmax(40px, 60px) auto; }
#dock-view .dock-part-actions { display: flex; align-items: center; gap: var(--space-3); }
#dock-view .dock-part-swap-row {
  display: flex; align-items: center; gap: var(--space-4);
  padding-top: var(--space-3); border-top: 1px solid var(--edge);
  font-size: var(--font-s); color: var(--text-dim);
}
#dock-view .dock-part-swap-select {
  flex: 1; background: var(--fill-1); color: var(--text);
  border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); font-size: var(--font-s);
}
#dock-view .dock-parts-columns { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-6); }
#dock-view .dock-parts-col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
#dock-view .dock-col-title { font-size: var(--font-m); color: var(--text-dim); border-bottom: 1px solid var(--edge); padding-bottom: var(--space-2); }
/* Shop tab */
#dock-view .dock-shop-header { margin-bottom: var(--space-5); font-size: var(--font-s); color: var(--text-dim); }
#dock-view .dock-shop-list { display: flex; flex-direction: column; gap: var(--space-3); }
#dock-view .dock-shop-item {
  display: flex; align-items: center; gap: var(--space-5); padding: var(--space-4) var(--space-5);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
}
#dock-view .dock-shop-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#dock-view .dock-shop-name { font-size: var(--font-l); }
#dock-view .dock-shop-type { font-size: var(--font-xs); color: var(--text-dim); }
#dock-view .dock-shop-props { font-size: var(--font-s); color: var(--text-dim); }
#dock-view .dock-shop-stats { font-size: var(--font-xs); color: var(--text-dim); }
#dock-view .dock-shop-actions { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2); }
#dock-view .dock-shop-price { font-size: var(--font-m); color: var(--accent); }
/* Common buttons: span. まで指定して .w-btn 側の背景色より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#dock-view span.dock-btn { background: var(--accent-fill-weak); color: var(--accent); }
#dock-view span.dock-btn:hover { background: var(--accent-fill); }

@media ${MQ_COMPACT} {
  /* ヘッダ: タイトル+閉じるを1行目、タブ列を折り返して2行目に積む。 */
  #dock-view .dock-header { flex-wrap: wrap; padding: var(--space-4) var(--space-5); }
  #dock-view .dock-tabs { flex: 1 1 100%; order: 3; }
  #dock-view .dock-status-bar, #dock-view .dock-body { padding-left: var(--space-5); padding-right: var(--space-5); }
  /* 部品グリッド: 搭載/倉庫を1列に積む。 */
  #dock-view .dock-parts-columns { grid-template-columns: 1fr; gap: var(--space-5); }
  #dock-view .dock-part-row-main { grid-template-columns: 1fr minmax(60px, 90px) auto; }
  #dock-view .dock-warehouse-row-main { grid-template-columns: 1fr auto; }
}
`;

let styleInjected = false;
// ドックビューのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// ショップで購入可能な部品カタログ
export interface PartCatalogEntry {
  readonly type: PartType;
  readonly name: string;
  readonly price: number;
  readonly weight: number;
  readonly maxHp: number;
  // 部品ごとの追加プロパティ (thruster の thrust など)
  readonly props: Record<string, number | string>;
}

// 既定パーツ(game-entity/ship.ts の initDefaultParts)と同じ単位・同じ桁で書く。
// 桁がずれると、換装した瞬間に推力や耐久が別物になる。既定艦の値は
// 重量 100 / 推力 PLAYER_MASS×最大スロットル / 冷却 25 / 発電 50 / 発射レート 1÷FIRE_INTERVAL。
const DEFAULT_TORQUE = C.MAX_ANG_ACCEL * Math.max(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL);
const DEFAULT_THRUST = C.PLAYER_MASS * C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!;
const SHOP_CATALOG: readonly PartCatalogEntry[] = [
  { type: 'hull', name: 'Standard Hull', price: 5000, weight: 80, maxHp: 300, props: {} },
  { type: 'hull', name: 'Reinforced Hull', price: 12000, weight: 180, maxHp: 600, props: {} },
  { type: 'cockpit', name: 'Basic Cockpit', price: 3000, weight: 100, maxHp: 100, props: {} },
  { type: 'armor', name: 'Light Armor', price: 2000, weight: 100, maxHp: 100, props: { damageReduction: 0.2 } },
  { type: 'armor', name: 'Heavy Armor', price: 8000, weight: 260, maxHp: 250, props: { damageReduction: 0.4 } },
  { type: 'thruster', name: 'Standard RCS', price: 4000, weight: 100, maxHp: 80, props: { torque: DEFAULT_TORQUE, thrust: DEFAULT_THRUST, fuelConsumptionRate: 1 } },
  { type: 'thruster', name: 'High-Thrust RCS', price: 10000, weight: 220, maxHp: 80, props: { torque: DEFAULT_TORQUE * 2, thrust: DEFAULT_THRUST * 2.5, fuelConsumptionRate: 2.5 } },
  { type: 'rcs_tank', name: 'Small RCS Tank', price: 1500, weight: 60, maxHp: 50, props: { maxFuel: 600, fuel: 600 } },
  { type: 'rcs_tank', name: 'Large RCS Tank', price: 4000, weight: 210, maxHp: 110, props: { maxFuel: 2200, fuel: 2200 } },
  { type: 'radiator', name: 'Heat Radiator', price: 3000, weight: 100, maxHp: 50, props: { coolingRate: 25 } },
  { type: 'radiator', name: 'Advanced Radiator', price: 7000, weight: 160, maxHp: 60, props: { coolingRate: 55 } },
  { type: 'solar_panel', name: 'Solar Array', price: 2500, weight: 100, maxHp: 30, props: { powerGeneration: 50 } },
  { type: 'solar_panel', name: 'High-Efficiency Solar', price: 6000, weight: 130, maxHp: 30, props: { powerGeneration: 120 } },
  { type: 'weapon', name: 'Gatling Gun', price: 5000, weight: 100, maxHp: 80, props: { weaponType: 'gatling', fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_BULLET_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED } },
  { type: 'weapon', name: 'Heavy Cannon', price: 15000, weight: 220, maxHp: 120, props: { weaponType: 'cannon', fireRate: 4, damage: C.ENEMY_BULLET_DAMAGE * 5, muzzleVelocity: C.MUZZLE_SPEED * 1.5 } },
];

// 修理コスト: 1HPあたりのクレジット
const REPAIR_COST_PER_HP = 10;
// 倉庫の部品を売却したときの掛け率。無限増殖を防ぐため購入価格を下回らせる。
const PART_SELL_RATE = 0.5;
// カタログに一致しない部品(艦に最初から積まれていたものなど)の売却基準額。maxHpに比例させる。
const PART_FALLBACK_VALUE_PER_MAXHP = 20;
// RCSタンクへの燃料補給コスト: 1kgあたりのクレジット
const RCS_REFUEL_PRICE_PER_KG = 2;
// 新造艦(既定パーツ一式)の価格。SHOP_CATALOG の最安構成の合計(≈31,500 Cr)に組立分を上乗せした額。
const NEW_SHIP_COST = 35000;

// 部品の売却基準額を見積もる。ショップカタログに type/name が一致する項目があればその価格を、
// なければ maxHp から概算した価格を使う(艦に最初から積まれていた部品など由来不明なもの向け)。
function estimatePartValue(part: AnyPart): number {
  const catalogEntry = SHOP_CATALOG.find((e) => e.type === part.type && e.name === part.name);
  return catalogEntry ? catalogEntry.price : part.maxHp * PART_FALLBACK_VALUE_PER_MAXHP;
}

function sellPrice(part: AnyPart): number {
  return Math.round(estimatePartValue(part) * PART_SELL_RATE);
}

function refuelCost(tank: RcsTankPart): number {
  return Math.max(0, Math.round((tank.maxFuel - tank.fuel) * RCS_REFUEL_PRICE_PER_KG));
}

export type DockTab = 'ships' | 'parts' | 'shop';

const TAB_ITEMS: readonly (readonly [DockTab, string])[] = [
  ['ships', '格納艦'],
  ['parts', '部品'],
  ['shop', 'ショップ'],
];

export class DockView {
  private readonly el: HTMLElement;
  private readonly tabBar: TabBar<DockTab>;
  private readonly moneyLabel: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private _visible = false;
  private currentBase: Base | null = null;
  private currentShip: Player | null = null;
  private currentTab: DockTab = 'ships';
  private freeProcurement = false;

  // 外部コールバック
  onLaunchShip: ((ship: Player, base: Base) => void) | null = null;
  // 「新造」ボタン。実際の艦の生成は Docking 側が行う(DockView は UI のみ)。
  onBuildShip: ((base: Base) => void) | null = null;
  onClose: (() => void) | null = null;

  get visible(): boolean { return this._visible; }
  get element(): HTMLElement { return this.el; }

  constructor(root: HTMLElement) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.id = 'dock-view';
    this.el.className = 'dock-view-overlay';
    this.el.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'dock-panel';

    const header = document.createElement('div');
    header.className = 'dock-header';
    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = 'dock';
    header.appendChild(title);

    this.tabBar = new TabBar<DockTab>(TAB_ITEMS, (tab) => {
      this.currentTab = tab;
      this.refresh();
    });
    this.tabBar.element.classList.add('dock-tabs');
    header.appendChild(this.tabBar.element);

    // 閉じる操作は要求を伝えるだけで、実際に閉じてポーズを解くのは onClose の受け手が行う。
    const closeBtn = new CloseButton(() => this.onClose?.());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    const statusBar = document.createElement('div');
    statusBar.className = 'dock-status-bar';
    this.moneyLabel = document.createElement('span');
    this.moneyLabel.textContent = '所持金: ---';
    statusBar.appendChild(this.moneyLabel);
    panel.appendChild(statusBar);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'dock-body';
    panel.appendChild(this.bodyEl);

    this.el.appendChild(panel);
    root.appendChild(this.el);
  }

  // ドックビューを開く
  open(base: Base, inspectShip: Player | null, freeProcurement: boolean): void {
    this.currentBase = base;
    this.freeProcurement = freeProcurement;
    // inspectShip が基地に格納されていれば選択状態にする
    if (inspectShip && base.baseState.dockedShips.some((s) => s.id === inspectShip.id)) {
      this.currentShip = inspectShip;
    } else {
      this.currentShip = null;
    }
    this.currentTab = 'ships';
    this.refresh();
    this.el.style.display = 'flex';
    this._visible = true;
  }

  close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.currentBase = null;
    this.currentShip = null;
  }

  private refresh(): void {
    if (!this.currentBase) return;

    this.moneyLabel.textContent = this.freeProcurement
      ? '所持金: ∞ (調達は無償)'
      : `所持金: ${this.currentBase.baseState.money.toLocaleString()} Cr`;
    this.tabBar.setSelected(this.currentTab);

    this.bodyEl.innerHTML = '';
    switch (this.currentTab) {
      case 'ships': this.bodyEl.appendChild(this.buildShipsTab()); break;
      case 'parts': this.bodyEl.appendChild(this.buildPartsTab()); break;
      case 'shop': this.bodyEl.appendChild(this.buildShopTab()); break;
    }
  }

  // ─── 格納艦タブ ───────────────────────────────────────────
  private buildShipsTab(): HTMLElement {
    const base = this.currentBase!;
    const frag = document.createElement('div');
    const ships = base.baseState.dockedShips;
    if (ships.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.innerHTML = '格納されている艦はありません。<br>ランデブー後に収容するか、新造してください。';
      frag.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'dock-ship-list';
      ships.forEach((s, i) => list.appendChild(this.buildShipRow(s, i)));
      frag.appendChild(list);
    }
    frag.appendChild(this.buildNewShipHeader(base));
    return frag;
  }

  private buildShipRow(s: DockedShipEntry, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-ship-row';
    row.classList.toggle('on', this.currentShip?.id === s.id);
    row.addEventListener('click', () => {
      this.currentShip = s.player;
      this.refresh();
    });

    const info = document.createElement('div');
    info.className = 'dock-ship-info';
    const name = document.createElement('span');
    name.className = 'dock-ship-name';
    name.textContent = s.name || `艦 #${i + 1}`;
    const hp = document.createElement('span');
    hp.className = 'dock-ship-hp';
    hp.textContent = `HP: ${Math.round(s.hp ?? 0)} / ${Math.round(s.maxHp ?? 0)}`;
    info.append(name, hp);
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'dock-ship-actions';
    const launchBtn = new Button('発進', () => this.handleLaunch(i));
    launchBtn.element.classList.add('dock-btn');
    const inspectBtn = new Button('詳細', () => this.handleInspect(i));
    inspectBtn.element.classList.add('dock-btn');
    actions.append(launchBtn.element, inspectBtn.element);
    row.appendChild(actions);
    return row;
  }

  // 新造(既定パーツ一式の艦を1隻、格納艦へ加える)行。
  private buildNewShipHeader(base: Base): HTMLElement {
    const canAfford = this.freeProcurement || base.baseState.money >= NEW_SHIP_COST;
    const row = document.createElement('div');
    row.className = 'dock-parts-header';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.textContent = '既定パーツ一式の艦を1隻建造します';
    row.appendChild(label);
    const btn = new Button(
      `新造 ${this.freeProcurement ? '(無料)' : `${NEW_SHIP_COST.toLocaleString()} Cr`}`,
      () => this.handleBuildShip(),
    );
    btn.element.classList.add('dock-btn');
    btn.setEnabled(canAfford);
    row.appendChild(btn.element);
    return row;
  }

  // ─── 部品タブ ───────────────────────────────────────────
  // 搭載部品(修理・換装・補給)と倉庫(在庫確認・売却・補給)を左右に並べ、
  // 同じ種類の部品を見比べながら換装先を選べるようにする。
  private buildPartsTab(): HTMLElement {
    const base = this.currentBase!;
    // 選択艦がなければ最初の艦を表示。倉庫は基地の持ち物なので、格納艦が居なくても出す。
    const ship = this.currentShip ?? null;
    const shipData = (ship ? base.baseState.dockedShips.find((s) => s.id === ship.id) : undefined)
      ?? base.baseState.dockedShips[0]
      ?? null;

    const frag = document.createElement('div');
    if (shipData) frag.appendChild(this.buildRepairAllHeader(base, shipData));

    const columns = document.createElement('div');
    columns.className = 'dock-parts-columns';

    const installedCol = document.createElement('div');
    installedCol.className = 'dock-parts-col';
    const installedTitle = document.createElement('div');
    installedTitle.className = 'dock-col-title';
    installedTitle.textContent = '搭載部品';
    installedCol.appendChild(installedTitle);
    if (shipData) {
      const list = document.createElement('div');
      list.className = 'dock-part-list';
      shipData.parts.forEach((p, i) => list.appendChild(this.buildInstalledPartRow(base, shipData, p, i)));
      installedCol.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.innerHTML = '格納艦がありません。<br>ランデブー後に収容すると、ここで整備できます。';
      installedCol.appendChild(empty);
    }
    columns.appendChild(installedCol);

    const warehouseCol = document.createElement('div');
    warehouseCol.className = 'dock-parts-col';
    const warehouseTitle = document.createElement('div');
    warehouseTitle.className = 'dock-col-title';
    warehouseTitle.textContent = '倉庫';
    warehouseCol.appendChild(warehouseTitle);
    warehouseCol.appendChild(this.buildWarehouseList(base));
    columns.appendChild(warehouseCol);

    frag.appendChild(columns);
    return frag;
  }

  // 艦の全部品をまとめて修理するボタンの行。
  private buildRepairAllHeader(base: Base, shipData: DockedShipEntry): HTMLElement {
    const totalRepairCost = shipData.parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    const enabled = totalRepairCost > 0 && (this.freeProcurement || base.baseState.money >= totalRepairCost);
    const row = document.createElement('div');
    row.className = 'dock-parts-header';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.textContent = `艦: ${shipData.name || '---'}`;
    row.appendChild(label);
    const btn = new Button(
      `全修理 ${this.freeProcurement ? '(無料)' : `${totalRepairCost.toLocaleString()} Cr`}`,
      () => this.handleRepairAll(shipData.id),
    );
    btn.element.classList.add('dock-btn');
    btn.setEnabled(enabled);
    row.appendChild(btn.element);
    return row;
  }

  // 搭載部品1件の行を作る。同じ type の在庫があれば換装欄を、rcs_tank なら補給ボタンを添える。
  private buildInstalledPartRow(base: Base, shipData: DockedShipEntry, p: Part, i: number): HTMLElement {
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    const repairCost = (p.maxHp - p.hp) * REPAIR_COST_PER_HP;
    const canRepair = repairCost > 0 && (this.freeProcurement || base.baseState.money >= repairCost);

    const row = document.createElement('div');
    row.className = 'dock-part-row';
    const main = document.createElement('div');
    main.className = 'dock-part-row-main';

    const info = document.createElement('div');
    info.className = 'dock-part-info';
    const name = document.createElement('span');
    name.className = 'dock-part-name';
    name.textContent = p.name;
    const type = document.createElement('span');
    type.className = 'dock-part-type';
    type.textContent = `[${p.type}]`;
    info.append(name, type);
    main.appendChild(info);

    const meter = new Meter();
    meter.element.classList.add('dock-part-hp-meter');
    meter.setRatio(hpPct / 100);
    // 3段階だった健全時/中間の色分けは Meter の「危険=DANGER」1本の規約へ統一する。
    meter.setDanger(hpPct <= 30);
    meter.setLabel(`${Math.round(p.hp)}/${p.maxHp}`);
    main.appendChild(meter.element);

    const actions = document.createElement('div');
    actions.className = 'dock-part-actions';
    const repairBtn = new Button(
      repairCost > 0 ? `修理 ${this.freeProcurement ? '無料' : repairCost + ' Cr'}` : '正常',
      () => this.handleRepairPart(shipData.id, i),
    );
    repairBtn.element.classList.add('dock-btn');
    repairBtn.setEnabled(canRepair);
    actions.appendChild(repairBtn.element);
    if (p.type === 'rcs_tank') {
      actions.appendChild(this.buildRefuelButton(base, p as RcsTankPart, () => this.handleRefuelInstalled(shipData.id, i)));
    }
    main.appendChild(actions);
    row.appendChild(main);

    const candidates = base.baseState.inventory.filter((inv) => inv.type === p.type);
    if (candidates.length > 0) row.appendChild(this.buildSwapRow(shipData.id, i, candidates));
    return row;
  }

  // 換装候補の選択欄(<select>)と換装ボタンの行。
  private buildSwapRow(shipId: string, partIdx: number, candidates: readonly AnyPart[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-part-swap-row';
    const label = document.createElement('span');
    label.textContent = '換装候補:';
    row.appendChild(label);
    const select = document.createElement('select');
    select.className = 'dock-part-swap-select';
    for (const c of candidates) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${Math.round(c.hp)}/${c.maxHp})`;
      select.appendChild(opt);
    }
    row.appendChild(select);
    const swapBtn = new Button('換装', () => this.handleSwapPart(shipId, partIdx, select.value));
    swapBtn.element.classList.add('dock-btn');
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
    for (const p of inventory) {
      const row = document.createElement('div');
      row.className = 'dock-part-row';
      const main = document.createElement('div');
      main.className = 'dock-part-row-main dock-warehouse-row-main';

      const info = document.createElement('div');
      info.className = 'dock-part-info';
      const name = document.createElement('span');
      name.className = 'dock-part-name';
      name.textContent = p.name;
      const type = document.createElement('span');
      type.className = 'dock-part-type';
      type.textContent = `[${p.type}]`;
      info.append(name, type);
      main.appendChild(info);

      const hpText = document.createElement('span');
      hpText.className = 'dock-part-hp-text';
      hpText.textContent = `${Math.round(p.hp)}/${p.maxHp}`;
      main.appendChild(hpText);

      const actions = document.createElement('div');
      actions.className = 'dock-part-actions';
      if (p.type === 'rcs_tank') {
        actions.appendChild(this.buildRefuelButton(base, p as RcsTankPart, () => this.handleRefuelInventory(p.id)));
      }
      const price = sellPrice(p);
      const sellBtn = new Button(`売却 ${price.toLocaleString()} Cr`, () => this.handleSellPart(p.id));
      sellBtn.element.classList.add('dock-btn');
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
    const canRefuel = cost > 0 && (this.freeProcurement || base.baseState.money >= cost);
    const btn = new Button(cost > 0 ? `燃料補給 ${this.freeProcurement ? '無料' : cost + ' Cr'}` : '満タン', onClick);
    btn.element.classList.add('dock-btn');
    btn.setEnabled(canRefuel);
    return btn.element;
  }

  // ─── ショップタブ ───────────────────────────────────────
  private buildShopTab(): HTMLElement {
    const base = this.currentBase!;
    const money = base.baseState.money;

    const frag = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'dock-shop-header';
    header.textContent = '部品ショップ — 購入した部品は基地の倉庫に追加されます';
    frag.appendChild(header);

    const list = document.createElement('div');
    list.className = 'dock-shop-list';
    SHOP_CATALOG.forEach((entry, i) => {
      const canBuy = this.freeProcurement || money >= entry.price;
      const props = Object.entries(entry.props).map(([k, v]) => `${k}: ${v}`).join(' / ');

      const item = document.createElement('div');
      item.className = 'dock-shop-item';
      const info = document.createElement('div');
      info.className = 'dock-shop-info';
      const name = document.createElement('span');
      name.className = 'dock-shop-name';
      name.textContent = entry.name;
      const type = document.createElement('span');
      type.className = 'dock-shop-type';
      type.textContent = `[${entry.type}]`;
      const propsEl = document.createElement('span');
      propsEl.className = 'dock-shop-props';
      propsEl.textContent = props;
      const stats = document.createElement('span');
      stats.className = 'dock-shop-stats';
      stats.textContent = `重量: ${entry.weight}kg | HP: ${entry.maxHp}`;
      info.append(name, type, propsEl, stats);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'dock-shop-actions';
      const price = document.createElement('span');
      price.className = 'dock-shop-price';
      price.textContent = this.freeProcurement ? '無料' : `${entry.price.toLocaleString()} Cr`;
      actions.appendChild(price);
      const buyBtn = new Button('購入 → 倉庫', () => this.handleBuy(i));
      buyBtn.element.classList.add('dock-btn');
      buyBtn.setEnabled(canBuy);
      actions.appendChild(buyBtn.element);
      item.appendChild(actions);
      list.appendChild(item);
    });
    frag.appendChild(list);
    return frag;
  }

  // ─── ハンドラ ────────────────────────────────────────────
  private handleLaunch(idx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState.dockedShips[idx];
    if (!shipData) return;
    this.onLaunchShip?.(shipData.player, base);
    base.baseState.dockedShips.splice(idx, 1);
    if (this.currentShip === shipData.player) this.currentShip = null;
    this.refresh();
  }

  // 新造費用を払い、実際の艦の生成(Docking 側)を要求する。
  private handleBuildShip(): void {
    const base = this.currentBase;
    if (!base) return;
    if (!this.freeProcurement && base.baseState.money < NEW_SHIP_COST) return;
    if (!this.freeProcurement) base.baseState.money -= NEW_SHIP_COST;
    this.onBuildShip?.(base);
    this.refresh();
  }

  private handleInspect(idx: number): void {
    const shipData = this.currentBase?.baseState.dockedShips[idx];
    if (!shipData) return;
    this.currentShip = shipData.player;
    this.currentTab = 'parts';
    this.refresh();
  }

  private handleRepairPart(shipId: string, partIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    if (!shipData) return;

    const part: Part | undefined = shipData.parts[partIdx];
    if (!part) return;
    const cost = (part.maxHp - part.hp) * REPAIR_COST_PER_HP;
    if (!this.freeProcurement && base.baseState.money < cost) return;

    if (!this.freeProcurement) base.baseState.money -= cost;
    part.hp = part.maxHp;
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRepairAll(shipId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    if (!shipData) return;

    const parts = shipData.parts;
    const totalCost = parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    if (!this.freeProcurement && base.baseState.money < totalCost) return;

    if (!this.freeProcurement) base.baseState.money -= totalCost;
    parts.forEach((p) => { p.hp = p.maxHp; });
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  // 格納中は shipData.parts が艦本体の parts 配列と同一参照なので、修理は艦へ直接反映される。
  // hp/maxHp の集計スナップショットだけは別に持っているので、艦一覧タブの表示用にここで揃える。
  private syncDockedSnapshot(shipData: DockedShipEntry): void {
    shipData.player.refreshFromParts();
    shipData.hp = shipData.player.hp;
    shipData.maxHp = shipData.player.maxHp;
  }

  // 搭載部品を、選択中の倉庫在庫(同じ type)と入れ替える。外した部品は倉庫へ戻す。
  // shipData.parts は player.parts と同一参照なので、splice による差し替えは艦の性能集計へ即反映される。
  private handleSwapPart(shipId: string, partIdx: number, invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    const installed = shipData?.parts[partIdx];
    if (!shipData || !installed) return;

    const invIdx = base.baseState.inventory.findIndex((p) => p.id === invId);
    const incoming = base.baseState.inventory[invIdx];
    if (!incoming || incoming.type !== installed.type) return;

    shipData.parts.splice(partIdx, 1, incoming);
    base.baseState.inventory.splice(invIdx, 1, installed as AnyPart);

    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRefuelInstalled(shipId: string, partIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    const part = shipData?.parts[partIdx];
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part as RcsTankPart);
    this.refresh();
  }

  private handleRefuelInventory(invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const part = base.baseState.inventory.find((p) => p.id === invId);
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part);
    this.refresh();
  }

  private refuelTank(base: Base, tank: RcsTankPart): void {
    const cost = refuelCost(tank);
    if (cost <= 0) return;
    if (!this.freeProcurement && base.baseState.money < cost) return;
    if (!this.freeProcurement) base.baseState.money -= cost;
    tank.fuel = tank.maxFuel;
  }

  private handleSellPart(invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const idx = base.baseState.inventory.findIndex((p) => p.id === invId);
    const part = base.baseState.inventory[idx];
    if (idx < 0 || !part) return;

    base.baseState.money += sellPrice(part);
    base.baseState.inventory.splice(idx, 1);
    this.refresh();
  }

  private handleBuy(catalogIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const entry = SHOP_CATALOG[catalogIdx];
    if (!entry) return;
    if (!this.freeProcurement && base.baseState.money < entry.price) return;

    const part = createPart(entry.type, {
      name: entry.name,
      weight: entry.weight,
      maxHp: entry.maxHp,
      hp: entry.maxHp,
      ...entry.props,
    } as Partial<AnyPart>);

    if (!this.freeProcurement) base.baseState.money -= entry.price;
    base.baseState.inventory.push(part);
    this.refresh();
  }

  dispose(): void {
    this.el.remove();
  }
}
