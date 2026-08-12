// ドックビュー: 基地に接岸した際に開くフルスクリーンUI。
// 格納されている船の一覧、部品の確認・修理・換装、ショップを提供する。
import type { Base, DockedShipEntry } from '../game-entity/base';
import type { Player } from '../player/player';
import type { AnyPart, Part, PartType, RcsTankPart } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';
import { ACCENT, DANGER, TEXT_MUTED } from '../theme';
import * as C from '../const';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export class DockView {
  private readonly el: HTMLElement;
  private _visible = false;
  private currentBase: Base | null = null;
  private currentShip: Player | null = null;
  private currentTab: DockTab = 'ships';
  private creative = false;

  // 外部コールバック
  onLaunchShip: ((ship: Player, base: Base) => void) | null = null;
  // 「新造」ボタン。実際の艦の生成は Docking 側が行う(DockView は UI のみ)。
  onBuildShip: ((base: Base) => void) | null = null;
  onClose: (() => void) | null = null;

  get visible(): boolean { return this._visible; }

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'dock-view';
    this.el.className = 'dock-view-overlay';
    this.el.style.display = 'none';
    this.el.innerHTML = this.buildHtml();
    root.appendChild(this.el);
    this.attachEvents();
  }

  // ドックビューを開く
  open(base: Base, inspectShip: Player | null, creative: boolean): void {
    this.currentBase = base;
    this.creative = creative;
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

  private buildHtml(): string {
    return `
      <div class="dock-panel">
        <div class="dock-header">
          <span class="dock-title">DOCK</span>
          <div class="dock-tabs">
            <button class="dock-tab-btn" data-tab="ships">格納艦</button>
            <button class="dock-tab-btn" data-tab="parts">部品</button>
            <button class="dock-tab-btn" data-tab="shop">ショップ</button>
          </div>
          <button class="dock-close-btn" id="dock-close">✕</button>
        </div>
        <div class="dock-status-bar">
          <span id="dock-base-money">所持金: ---</span>
        </div>
        <div class="dock-body" id="dock-body">
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    // 閉じる操作は要求を伝えるだけで、実際に閉じてポーズを解くのは onClose の受け手が行う。
    this.el.querySelector('#dock-close')?.addEventListener('click', () => this.onClose?.());

    this.el.querySelectorAll('.dock-tab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.target as HTMLElement).dataset['tab'] as DockTab;
        if (tab) {
          this.currentTab = tab;
          this.refresh();
        }
      });
    });
  }

  private refresh(): void {
    if (!this.currentBase) return;

    const moneyEl = this.el.querySelector('#dock-base-money');
    if (moneyEl) {
      const moneyText = this.creative
        ? '所持金: ∞ (クリエイティブ)'
        : `所持金: ${this.currentBase.baseState.money.toLocaleString()} Cr`;
      moneyEl.textContent = moneyText;
    }

    // タブアクティブ状態更新
    this.el.querySelectorAll('.dock-tab-btn').forEach((btn) => {
      const tab = (btn as HTMLElement).dataset['tab'];
      btn.classList.toggle('active', tab === this.currentTab);
    });

    const body = this.el.querySelector('#dock-body');
    if (!body) return;

    switch (this.currentTab) {
      case 'ships': body.innerHTML = this.buildShipsTab(); break;
      case 'parts': body.innerHTML = this.buildPartsTab(); break;
      case 'shop': body.innerHTML = this.buildShopTab(); break;
    }

    this.attachTabEvents();
  }

  // ─── 格納艦タブ ───────────────────────────────────────────
  private buildShipsTab(): string {
    const base = this.currentBase!;
    const ships = base.baseState.dockedShips;
    const list = ships.length === 0
      ? `<div class="dock-empty">格納されている艦はありません。<br>ランデブー後に収容するか、新造してください。</div>`
      : `<div class="dock-ship-list">${ships.map((s, i) => this.buildShipRow(s, i)).join('')}</div>`;
    return list + this.buildNewShipHeader(base);
  }

  private buildShipRow(s: DockedShipEntry, i: number): string {
    return `
      <div class="dock-ship-row ${this.currentShip?.id === s.id ? 'selected' : ''}" data-ship-idx="${i}">
        <div class="dock-ship-info">
          <span class="dock-ship-name">${s.name ? esc(s.name) : `艦 #${i + 1}`}</span>
          <span class="dock-ship-hp">HP: ${Math.round(s.hp ?? 0)} / ${Math.round(s.maxHp ?? 0)}</span>
        </div>
        <div class="dock-ship-actions">
          <button class="dock-btn dock-btn-launch" data-ship-idx="${i}">発進</button>
          <button class="dock-btn dock-btn-inspect" data-ship-idx="${i}">詳細</button>
        </div>
      </div>
    `;
  }

  // 新造(既定パーツ一式の艦を1隻、格納艦へ加える)ボタン。
  private buildNewShipHeader(base: Base): string {
    const canAfford = this.creative || base.baseState.money >= NEW_SHIP_COST;
    return `
      <div class="dock-parts-header">
        <span class="dock-ship-label">既定パーツ一式の艦を1隻建造します</span>
        <button class="dock-btn dock-btn-build-ship ${canAfford ? '' : 'disabled'}" ${canAfford ? '' : 'disabled'}
        >新造 ${this.creative ? '(無料)' : `${NEW_SHIP_COST.toLocaleString()} Cr`}</button>
      </div>
    `;
  }

  // ─── 部品タブ ───────────────────────────────────────────
  // 搭載部品(修理・換装・補給)と倉庫(在庫確認・売却・補給)を左右に並べ、
  // 同じ種類の部品を見比べながら換装先を選べるようにする。
  private buildPartsTab(): string {
    const base = this.currentBase!;
    // 選択艦がなければ最初の艦を表示。倉庫は基地の持ち物なので、格納艦が居なくても出す。
    const ship = this.currentShip ?? null;
    const shipData = (ship ? base.baseState.dockedShips.find((s) => s.id === ship.id) : undefined)
      ?? base.baseState.dockedShips[0]
      ?? null;

    return `
      ${shipData ? this.buildRepairAllHeader(base, shipData) : ''}
      <div class="dock-parts-columns">
        <div class="dock-parts-col">
          <div class="dock-col-title">搭載部品</div>
          ${shipData
            ? `<div class="dock-part-list">${shipData.parts.map((p, i) => this.buildInstalledPartRow(base, shipData, p, i)).join('')}</div>`
            : `<div class="dock-empty">格納艦がありません。<br>ランデブー後に収容すると、ここで整備できます。</div>`}
        </div>
        <div class="dock-parts-col">
          <div class="dock-col-title">倉庫</div>
          ${this.buildWarehouseList(base)}
        </div>
      </div>
    `;
  }

  // 艦の全部品をまとめて修理するボタンの行。
  private buildRepairAllHeader(base: Base, shipData: DockedShipEntry): string {
    const totalRepairCost = shipData.parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    const enabled = totalRepairCost > 0 && (this.creative || base.baseState.money >= totalRepairCost);
    return `
      <div class="dock-parts-header">
        <span class="dock-ship-label">艦: ${shipData.name ? esc(shipData.name) : '---'}</span>
        <button class="dock-btn dock-btn-repair-all ${enabled ? '' : 'disabled'}"
          data-ship-id="${shipData.id}"
          ${enabled ? '' : 'disabled'}
        >全修理 ${this.creative ? '(無料)' : `${totalRepairCost.toLocaleString()} Cr`}</button>
      </div>
    `;
  }

  // 搭載部品1件の行を作る。同じ type の在庫があれば換装欄を、rcs_tank なら補給ボタンを添える。
  private buildInstalledPartRow(base: Base, shipData: DockedShipEntry, p: Part, i: number): string {
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    const hpColor = hpPct > 60 ? TEXT_MUTED : hpPct > 30 ? ACCENT : DANGER;
    const repairCost = (p.maxHp - p.hp) * REPAIR_COST_PER_HP;
    const canRepair = repairCost > 0 && (this.creative || base.baseState.money >= repairCost);

    const refuelHtml = p.type === 'rcs_tank' ? this.buildRefuelButton(base, p as RcsTankPart, {
      'data-ship-id': shipData.id, 'data-part-idx': String(i),
    }, 'dock-btn-refuel-installed') : '';

    const candidates = base.baseState.inventory.filter((inv) => inv.type === p.type);
    const swapHtml = candidates.length === 0 ? '' : `
      <div class="dock-part-swap-row">
        <span>換装候補:</span>
        <select class="dock-part-swap-select" data-part-idx="${i}">
          ${candidates.map((c) => `<option value="${c.id}">${c.name} (${Math.round(c.hp)}/${c.maxHp})</option>`).join('')}
        </select>
        <button class="dock-btn dock-btn-swap" data-ship-id="${shipData.id}" data-part-idx="${i}">換装</button>
      </div>
    `;

    return `
      <div class="dock-part-row">
        <div class="dock-part-row-main">
          <div class="dock-part-info">
            <span class="dock-part-name">${p.name}</span>
            <span class="dock-part-type">[${p.type}]</span>
          </div>
          <div class="dock-part-hp-bar">
            <div class="dock-part-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
          </div>
          <span class="dock-part-hp-text">${Math.round(p.hp)}/${p.maxHp}</span>
          <div class="dock-part-actions">
            <button class="dock-btn dock-btn-repair ${canRepair ? '' : 'disabled'}"
              data-part-idx="${i}"
              data-ship-id="${shipData.id}"
              ${canRepair ? '' : 'disabled'}
            >${repairCost > 0 ? `修理 ${this.creative ? '無料' : repairCost + ' Cr'}` : '正常'}</button>
            ${refuelHtml}
          </div>
        </div>
        ${swapHtml}
      </div>
    `;
  }

  // 倉庫にある在庫部品の一覧。売却と、rcs_tank ならその場での補給を提供する。
  private buildWarehouseList(base: Base): string {
    const inventory = base.baseState.inventory;
    if (inventory.length === 0) {
      return `<div class="dock-empty">倉庫は空です。ショップで購入するか、艦から部品を外すと入ります。</div>`;
    }
    const rows = inventory.map((p) => {
      const refuelHtml = p.type === 'rcs_tank'
        ? this.buildRefuelButton(base, p as RcsTankPart, { 'data-inv-id': p.id }, 'dock-btn-refuel-inventory')
        : '';
      const price = sellPrice(p);
      return `
        <div class="dock-part-row">
          <div class="dock-part-row-main dock-warehouse-row-main">
            <div class="dock-part-info">
              <span class="dock-part-name">${p.name}</span>
              <span class="dock-part-type">[${p.type}]</span>
            </div>
            <span class="dock-part-hp-text">${Math.round(p.hp)}/${p.maxHp}</span>
            <div class="dock-part-actions">
              ${refuelHtml}
              <button class="dock-btn dock-btn-sell" data-inv-id="${p.id}">売却 ${price.toLocaleString()} Cr</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
    return `<div class="dock-part-list">${rows}</div>`;
  }

  // rcs_tank 用の補給ボタンを作る。data 属性は呼び出し側(搭載/倉庫)ごとに異なる識別子を渡す。
  private buildRefuelButton(base: Base, tank: RcsTankPart, dataAttrs: Record<string, string>, btnClass: string): string {
    const cost = refuelCost(tank);
    const canRefuel = cost > 0 && (this.creative || base.baseState.money >= cost);
    const attrs = Object.entries(dataAttrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `
      <button class="dock-btn ${btnClass} ${canRefuel ? '' : 'disabled'}" ${attrs} ${canRefuel ? '' : 'disabled'}
      >${cost > 0 ? `燃料補給 ${this.creative ? '無料' : cost + ' Cr'}` : '満タン'}</button>
    `;
  }

  // ─── ショップタブ ───────────────────────────────────────
  private buildShopTab(): string {
    const base = this.currentBase!;
    const money = base.baseState.money;

    const items = SHOP_CATALOG.map((entry, i) => {
      const canBuy = this.creative || money >= entry.price;
      const props = Object.entries(entry.props)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' / ');
      return `
        <div class="dock-shop-item">
          <div class="dock-shop-info">
            <span class="dock-shop-name">${entry.name}</span>
            <span class="dock-shop-type">[${entry.type}]</span>
            <span class="dock-shop-props">${props}</span>
            <span class="dock-shop-stats">重量: ${entry.weight}kg | HP: ${entry.maxHp}</span>
          </div>
          <div class="dock-shop-actions">
            <span class="dock-shop-price">${this.creative ? '無料' : entry.price.toLocaleString() + ' Cr'}</span>
            <button class="dock-btn dock-btn-buy ${canBuy ? '' : 'disabled'}"
              data-catalog-idx="${i}"
              ${canBuy ? '' : 'disabled'}
            >購入 → 倉庫</button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="dock-shop-header">
        <span>部品ショップ — 購入した部品は基地の倉庫に追加されます</span>
      </div>
      <div class="dock-shop-list">${items}</div>
    `;
  }

  // ─── タブ内イベント ──────────────────────────────────────
  private attachTabEvents(): void {
    // 格納艦タブ: 発進・詳細
    this.el.querySelectorAll('.dock-btn-launch').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleLaunch(e));
    });
    this.el.querySelectorAll('.dock-btn-inspect').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleInspect(e));
    });
    this.el.querySelectorAll('.dock-btn-build-ship').forEach((btn) => {
      btn.addEventListener('click', () => this.handleBuildShip());
    });
    // 部品タブ: 修理・全修理
    this.el.querySelectorAll('.dock-btn-repair').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleRepairPart(e));
    });
    this.el.querySelectorAll('.dock-btn-repair-all').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleRepairAll(e));
    });
    // 部品タブ: 換装・補給・売却
    this.el.querySelectorAll('.dock-btn-swap').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleSwapPart(e));
    });
    this.el.querySelectorAll('.dock-btn-refuel-installed').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleRefuelInstalled(e));
    });
    this.el.querySelectorAll('.dock-btn-refuel-inventory').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleRefuelInventory(e));
    });
    this.el.querySelectorAll('.dock-btn-sell').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleSellPart(e));
    });
    // ショップタブ: 購入
    this.el.querySelectorAll('.dock-btn-buy').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleBuy(e));
    });
    // 艦行クリックで選択
    this.el.querySelectorAll('.dock-ship-row').forEach((row) => {
      row.addEventListener('click', () => {
        const idx = parseInt((row as HTMLElement).dataset['shipIdx'] ?? '-1', 10);
        const shipData = this.currentBase?.baseState.dockedShips[idx];
        if (!shipData) return;
        this.currentShip = shipData.player;
        this.refresh();
      });
    });
  }

  private handleLaunch(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const idx = parseInt((e.target as HTMLElement).dataset['shipIdx'] ?? '-1', 10);
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
    if (!this.creative && base.baseState.money < NEW_SHIP_COST) return;
    if (!this.creative) base.baseState.money -= NEW_SHIP_COST;
    this.onBuildShip?.(base);
    this.refresh();
  }

  private handleInspect(e: Event): void {
    const idx = parseInt((e.target as HTMLElement).dataset['shipIdx'] ?? '-1', 10);
    const shipData = this.currentBase?.baseState.dockedShips[idx];
    if (!shipData) return;
    this.currentShip = shipData.player;
    this.currentTab = 'parts';
    this.refresh();
  }

  private handleRepairPart(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const partIdx = parseInt(btn.dataset['partIdx'] ?? '-1', 10);
    const shipId = btn.dataset['shipId'];
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    if (!shipData || partIdx < 0) return;

    const part: Part | undefined = shipData.parts[partIdx];
    if (!part) return;
    const cost = (part.maxHp - part.hp) * REPAIR_COST_PER_HP;
    if (!this.creative && base.baseState.money < cost) return;

    if (!this.creative) base.baseState.money -= cost;
    part.hp = part.maxHp;
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRepairAll(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const shipId = btn.dataset['shipId'];
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    if (!shipData) return;

    const parts = shipData.parts;
    const totalCost = parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    if (!this.creative && base.baseState.money < totalCost) return;

    if (!this.creative) base.baseState.money -= totalCost;
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
  private handleSwapPart(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const shipId = btn.dataset['shipId'];
    const partIdx = parseInt(btn.dataset['partIdx'] ?? '-1', 10);
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    const installed = shipData?.parts[partIdx];
    if (!shipData || !installed) return;

    const select = btn.parentElement?.querySelector('select') as HTMLSelectElement | null;
    const invId = select?.value;
    const invIdx = base.baseState.inventory.findIndex((p) => p.id === invId);
    const incoming = base.baseState.inventory[invIdx];
    if (!incoming || incoming.type !== installed.type) return;

    shipData.parts.splice(partIdx, 1, incoming);
    base.baseState.inventory.splice(invIdx, 1, installed as AnyPart);

    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRefuelInstalled(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const shipId = btn.dataset['shipId'];
    const partIdx = parseInt(btn.dataset['partIdx'] ?? '-1', 10);
    const shipData = base.baseState.dockedShips.find((s) => s.id === shipId);
    const part = shipData?.parts[partIdx];
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part as RcsTankPart);
    this.refresh();
  }

  private handleRefuelInventory(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const invId = btn.dataset['invId'];
    const part = base.baseState.inventory.find((p) => p.id === invId);
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part);
    this.refresh();
  }

  private refuelTank(base: Base, tank: RcsTankPart): void {
    const cost = refuelCost(tank);
    if (cost <= 0) return;
    if (!this.creative && base.baseState.money < cost) return;
    if (!this.creative) base.baseState.money -= cost;
    tank.fuel = tank.maxFuel;
  }

  private handleSellPart(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const invId = btn.dataset['invId'];
    const idx = base.baseState.inventory.findIndex((p) => p.id === invId);
    const part = base.baseState.inventory[idx];
    if (idx < 0 || !part) return;

    base.baseState.money += sellPrice(part);
    base.baseState.inventory.splice(idx, 1);
    this.refresh();
  }

  private handleBuy(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const idx = parseInt((e.target as HTMLElement).dataset['catalogIdx'] ?? '-1', 10);
    const entry = SHOP_CATALOG[idx];
    if (!entry) return;
    if (!this.creative && base.baseState.money < entry.price) return;

    const part = createPart(entry.type, {
      name: entry.name,
      weight: entry.weight,
      maxHp: entry.maxHp,
      hp: entry.maxHp,
      ...entry.props,
    } as Partial<AnyPart>);

    if (!this.creative) base.baseState.money -= entry.price;
    base.baseState.inventory.push(part);
    this.refresh();
  }

  dispose(): void {
    this.el.remove();
  }
}
