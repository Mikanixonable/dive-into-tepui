// ドックビュー: 基地に接岸した際に開くフルスクリーンUI。
// 格納されている船の一覧、部品の確認・修理・換装、ショップを提供する。
import type { Base } from '../game-entity/base';
import type { Player } from '../player/player';
import type { AnyPart, PartType } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';

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

const SHOP_CATALOG: readonly PartCatalogEntry[] = [
  { type: 'hull', name: 'Standard Hull', price: 5000, weight: 2000, maxHp: 200, props: {} },
  { type: 'hull', name: 'Reinforced Hull', price: 12000, weight: 3500, maxHp: 500, props: {} },
  { type: 'cockpit', name: 'Basic Cockpit', price: 3000, weight: 500, maxHp: 50, props: {} },
  { type: 'armor', name: 'Light Armor', price: 2000, weight: 800, maxHp: 100, props: { damageReduction: 0.2 } },
  { type: 'armor', name: 'Heavy Armor', price: 8000, weight: 2500, maxHp: 300, props: { damageReduction: 0.4 } },
  { type: 'thruster', name: 'Standard RCS', price: 4000, weight: 400, maxHp: 60, props: { torque: 50, thrust: 100, fuelConsumptionRate: 1 } },
  { type: 'thruster', name: 'High-Thrust RCS', price: 10000, weight: 600, maxHp: 60, props: { torque: 120, thrust: 300, fuelConsumptionRate: 2.5 } },
  { type: 'rcs_tank', name: 'Small RCS Tank', price: 1500, weight: 200, maxHp: 30, props: { maxFuel: 500, fuel: 500 } },
  { type: 'rcs_tank', name: 'Large RCS Tank', price: 4000, weight: 500, maxHp: 50, props: { maxFuel: 2000, fuel: 2000 } },
  { type: 'radiator', name: 'Heat Radiator', price: 3000, weight: 300, maxHp: 40, props: { coolingRate: 50 } },
  { type: 'radiator', name: 'Advanced Radiator', price: 7000, weight: 500, maxHp: 60, props: { coolingRate: 120 } },
  { type: 'solar_panel', name: 'Solar Array', price: 2500, weight: 150, maxHp: 20, props: { powerGeneration: 100 } },
  { type: 'solar_panel', name: 'High-Efficiency Solar', price: 6000, weight: 200, maxHp: 25, props: { powerGeneration: 250 } },
  { type: 'weapon', name: 'Gatling Gun', price: 5000, weight: 600, maxHp: 40, props: { weaponType: 'gatling', fireRate: 10, damage: 1, muzzleVelocity: 1000 } },
  { type: 'weapon', name: 'Heavy Cannon', price: 15000, weight: 1500, maxHp: 80, props: { weaponType: 'cannon', fireRate: 2, damage: 8, muzzleVelocity: 1500 } },
];

// 修理コスト: 1HPあたりのクレジット
const REPAIR_COST_PER_HP = 10;

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
    this.render();
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
    this.el.querySelector('#dock-close')?.addEventListener('click', () => {
      this.onClose?.();
      this.close();
    });

    this.el.querySelectorAll('.dock-tab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.target as HTMLElement).dataset['tab'] as DockTab;
        if (tab) {
          this.currentTab = tab;
          this.render();
        }
      });
    });

    // ESCキーで閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._visible) {
        this.onClose?.();
        this.close();
      }
    });
  }

  private render(): void {
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
      case 'ships': body.innerHTML = this.renderShipsTab(); break;
      case 'parts': body.innerHTML = this.renderPartsTab(); break;
      case 'shop': body.innerHTML = this.renderShopTab(); break;
    }

    this.attachTabEvents();
  }

  // ─── 格納艦タブ ───────────────────────────────────────────
  private renderShipsTab(): string {
    const base = this.currentBase!;
    const ships = base.baseState.dockedShips;
    if (ships.length === 0) {
      return `<div class="dock-empty">格納されている艦はありません。<br>ランデブー後に収容できます。</div>`;
    }
    const rows = ships.map((s: any, i: number) => `
      <div class="dock-ship-row ${this.currentShip?.id === s.id ? 'selected' : ''}" data-ship-idx="${i}">
        <div class="dock-ship-info">
          <span class="dock-ship-name">${s.name ?? `艦 #${i + 1}`}</span>
          <span class="dock-ship-hp">HP: ${Math.round(s.hp ?? 0)} / ${Math.round(s.maxHp ?? 0)}</span>
        </div>
        <div class="dock-ship-actions">
          <button class="dock-btn dock-btn-launch" data-ship-idx="${i}">発進</button>
          <button class="dock-btn dock-btn-inspect" data-ship-idx="${i}">詳細</button>
        </div>
      </div>
    `).join('');
    return `<div class="dock-ship-list">${rows}</div>`;
  }

  // ─── 部品タブ ───────────────────────────────────────────
  private renderPartsTab(): string {
    const base = this.currentBase!;
    const ships = base.baseState.dockedShips;
    if (ships.length === 0) {
      return `<div class="dock-empty">格納艦がありません。</div>`;
    }

    // 選択艦がなければ最初の艦を表示
    const ship = this.currentShip ?? null;
    const shipData = ship
      ? (base.baseState.dockedShips.find((s: any) => s.id === ship.id) ?? null)
      : (base.baseState.dockedShips[0] ?? null);

    if (!shipData) return `<div class="dock-empty">艦を選択してください。</div>`;

    const parts: AnyPart[] = shipData.parts ?? [];
    const totalRepairCost = parts.reduce((sum: number, p: AnyPart) => {
      const missing = p.maxHp - p.hp;
      return sum + missing * REPAIR_COST_PER_HP;
    }, 0);

    const partRows = parts.map((p: AnyPart, i: number) => {
      const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
      const hpColor = hpPct > 60 ? '#4caf50' : hpPct > 30 ? '#ff9800' : '#f44336';
      const repairCost = (p.maxHp - p.hp) * REPAIR_COST_PER_HP;
      const canRepair = repairCost > 0 && (this.creative || base.baseState.money >= repairCost);
      return `
        <div class="dock-part-row">
          <div class="dock-part-info">
            <span class="dock-part-name">${p.name}</span>
            <span class="dock-part-type">[${p.type}]</span>
          </div>
          <div class="dock-part-hp-bar">
            <div class="dock-part-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
          </div>
          <span class="dock-part-hp-text">${Math.round(p.hp)}/${p.maxHp}</span>
          <button class="dock-btn dock-btn-repair ${canRepair ? '' : 'disabled'}"
            data-part-idx="${i}"
            data-ship-id="${shipData.id}"
            ${canRepair ? '' : 'disabled'}
          >${repairCost > 0 ? `修理 ${this.creative ? '無料' : repairCost + ' Cr'}` : '正常'}</button>
        </div>
      `;
    }).join('');

    const repairAllCanAfford = this.creative || base.baseState.money >= totalRepairCost;
    return `
      <div class="dock-parts-header">
        <span class="dock-ship-label">艦: ${shipData.name ?? '---'}</span>
        <button class="dock-btn dock-btn-repair-all ${repairAllCanAfford && totalRepairCost > 0 ? '' : 'disabled'}"
          data-ship-id="${shipData.id}"
          ${repairAllCanAfford && totalRepairCost > 0 ? '' : 'disabled'}
        >全修理 ${this.creative ? '(無料)' : `${totalRepairCost.toLocaleString()} Cr`}</button>
      </div>
      <div class="dock-part-list">${partRows}</div>
    `;
  }

  // ─── ショップタブ ───────────────────────────────────────
  private renderShopTab(): string {
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
    // 部品タブ: 修理・全修理
    this.el.querySelectorAll('.dock-btn-repair').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleRepairPart(e));
    });
    this.el.querySelectorAll('.dock-btn-repair-all').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleRepairAll(e));
    });
    // ショップタブ: 購入
    this.el.querySelectorAll('.dock-btn-buy').forEach((btn) => {
      btn.addEventListener('click', (e) => this.handleBuy(e));
    });
    // 艦行クリックで選択
    this.el.querySelectorAll('.dock-ship-row').forEach((row) => {
      row.addEventListener('click', () => {
        const idx = parseInt((row as HTMLElement).dataset['shipIdx'] ?? '-1', 10);
        if (idx >= 0) {
          // 選択状態だけ更新してタブ再描画
          this.el.querySelectorAll('.dock-ship-row').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
        }
      });
    });
  }

  private handleLaunch(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const idx = parseInt((e.target as HTMLElement).dataset['shipIdx'] ?? '-1', 10);
    if (idx < 0) return;
    const shipData = base.baseState.dockedShips[idx];
    if (!shipData) return;
    // 外部に通知 (実際の発進は Game 側で行う)
    if (this.onLaunchShip && shipData._playerRef) {
      this.onLaunchShip(shipData._playerRef as Player, base);
      base.baseState.dockedShips.splice(idx, 1);
      this.render();
    }
  }

  private handleInspect(e: Event): void {
    const idx = parseInt((e.target as HTMLElement).dataset['shipIdx'] ?? '-1', 10);
    if (idx < 0 || !this.currentBase) return;
    // 部品タブへ切り替え
    this.currentTab = 'parts';
    this.render();
  }

  private handleRepairPart(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const partIdx = parseInt(btn.dataset['partIdx'] ?? '-1', 10);
    const shipId = btn.dataset['shipId'];
    const shipData = base.baseState.dockedShips.find((s: any) => s.id === shipId);
    if (!shipData || partIdx < 0) return;

    const part: AnyPart = shipData.parts[partIdx];
    if (!part) return;
    const cost = (part.maxHp - part.hp) * REPAIR_COST_PER_HP;
    if (!this.creative && base.baseState.money < cost) return;

    // 修理実行
    if (!this.creative) base.baseState.money -= cost;
    part.hp = part.maxHp;
    // 実機への反映
    if (shipData._playerRef) {
      const player = shipData._playerRef as Player;
      const playerPart = player.parts[partIdx];
      if (playerPart) {
        playerPart.hp = playerPart.maxHp;
        player.hp = player.parts.reduce((s, p) => s + p.hp, 0);
        player.maxHp = player.parts.reduce((s, p) => s + p.maxHp, 0);
      }
    }
    this.render();
  }

  private handleRepairAll(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const btn = e.target as HTMLElement;
    const shipId = btn.dataset['shipId'];
    const shipData = base.baseState.dockedShips.find((s: any) => s.id === shipId);
    if (!shipData) return;

    const parts: AnyPart[] = shipData.parts ?? [];
    const totalCost = parts.reduce((sum: number, p: AnyPart) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    if (!this.creative && base.baseState.money < totalCost) return;

    if (!this.creative) base.baseState.money -= totalCost;
    parts.forEach((p: AnyPart) => { p.hp = p.maxHp; });

    // 実機への反映
    if (shipData._playerRef) {
      const player = shipData._playerRef as Player;
      player.parts.forEach((p) => { p.hp = p.maxHp; });
      player.hp = player.maxHp;
    }
    this.render();
  }

  private handleBuy(e: Event): void {
    const base = this.currentBase;
    if (!base) return;
    const idx = parseInt((e.target as HTMLElement).dataset['catalogIdx'] ?? '-1', 10);
    const entry = SHOP_CATALOG[idx];
    if (!entry) return;
    if (!this.creative && base.baseState.money < entry.price) return;

    // 部品を生成して倉庫へ追加
    const part = createPart(entry.type as any, {
      name: entry.name,
      weight: entry.weight,
      maxHp: entry.maxHp,
      hp: entry.maxHp,
      ...entry.props,
    } as any);

    if (!this.creative) base.baseState.money -= entry.price;
    base.baseState.inventory.push(part as any);
    this.render();
  }

  dispose(): void {
    this.el.remove();
  }
}
