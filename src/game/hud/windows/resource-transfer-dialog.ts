// ドッキング中の船同士・船と基地の間で電力・物資(弾薬・RCS燃料・パーツ)を融通するダイアログ。
import { Player } from '../../player/player';
import { Base } from '../../game-entity/base';
import type { GameEntity } from '../../game-entity/game-entity';
import type { RcsTankPart } from '../../game-entity/parts';
import * as C from '../../const';
import type { OverlayManager } from '../overlay-manager';
import { fmtEnergy } from '../utils';

const STYLE = `
#resource-transfer-dialog.rt-overlay {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(3px);
  font-family: var(--font-neutral, var(--font-family));
  pointer-events: auto; z-index: var(--z-resource-transfer-dialog);
}
#resource-transfer-dialog .rt-panel {
  width: min(900px, 94vw); max-height: min(720px, 90vh);
  display: flex; flex-direction: column;
  background: var(--surface-1); border: 1px solid var(--edge);
  border-radius: var(--radius-window); overflow: hidden;
  color: var(--body);
}
#resource-transfer-dialog .rt-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--edge);
  background: var(--surface-2);
}
#resource-transfer-dialog .rt-title {
  margin: 0; font-size: var(--font-xl); font-weight: 600; color: var(--title);
}
#resource-transfer-dialog .rt-subtitle {
  margin-top: 2px; font-size: var(--font-xs); color: var(--muted);
}
#resource-transfer-dialog .rt-body {
  flex: 1 1 auto; overflow-y: auto; padding: 18px;
  display: flex; flex-direction: column; gap: 16px;
  scrollbar-width: thin;
}
#resource-transfer-dialog .rt-grid {
  display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; align-items: center;
}
#resource-transfer-dialog .rt-card {
  padding: 14px; border-radius: var(--radius-panel);
  background: var(--surface-2); border: 1px solid var(--edge);
  display: flex; flex-direction: column; gap: 8px;
}
#resource-transfer-dialog .rt-card-title {
  font-size: var(--font-s); font-weight: 600; color: var(--color-primary);
}
#resource-transfer-dialog .rt-metric {
  display: flex; justify-content: space-between; font-size: var(--font-s);
  font-variant-numeric: tabular-nums;
}
#resource-transfer-dialog .rt-metric-val {
  font-weight: 600; color: var(--title);
}
#resource-transfer-dialog .rt-section-head {
  font-size: var(--font-s); font-weight: 600; color: var(--color-signal);
  border-bottom: 1px solid var(--edge); padding-bottom: 4px; margin-bottom: 8px;
}
#resource-transfer-dialog .rt-actions {
  display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center;
}
#resource-transfer-dialog .rt-btn-group {
  display: flex; gap: 6px; flex-wrap: wrap; justify-content: center;
}
#resource-transfer-dialog .rt-inv-list {
  max-height: 120px; overflow-y: auto; scrollbar-width: thin;
  display: flex; flex-direction: column; gap: 4px;
}
#resource-transfer-dialog .rt-inv-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4px 8px; border-radius: var(--radius-control);
  background: var(--surface-3); font-size: var(--font-xs); cursor: pointer;
}
#resource-transfer-dialog .rt-inv-item:hover {
  background: var(--surface-1); border-color: var(--color-primary);
}
`;

export class ResourceTransferDialog {
  private readonly rootEl: HTMLElement;
  private isOpen = false;

  private shipA: Player | null = null;
  private entityB: GameEntity | null = null;

  public onClose?: () => void;

  constructor(
    parent: HTMLElement,
    private readonly overlayManager?: OverlayManager,
  ) {
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);

    this.rootEl = document.createElement('div');
    this.rootEl.id = 'resource-transfer-dialog';
    this.rootEl.className = 'rt-overlay';
    this.rootEl.style.display = 'none';
    parent.appendChild(this.rootEl);
  }

  open(shipA: Player, entityB: GameEntity): void {
    this.shipA = shipA;
    this.entityB = entityB;
    this.isOpen = true;
    this.rootEl.style.display = 'flex';

    if (this.overlayManager) {
      this.overlayManager.open('resource-transfer-dialog', {
        contains: (node: Node) => this.rootEl.contains(node),
        close: () => this.close(),
      }, {
        kind: 'modal',
        closeOnEscape: true,
        closeOnOutsideClick: true,
        gatesInput: true,
      });
    }

    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.rootEl.style.display = 'none';
    if (this.overlayManager) {
      this.overlayManager.close('resource-transfer-dialog');
    }
    if (this.onClose) this.onClose();
  }

  private render(): void {
    if (!this.shipA || !this.entityB) return;
    const a = this.shipA;
    const b = this.entityB;

    const bName = b.name || (b instanceof Base ? '基地' : '他艦');
    const isBBase = b instanceof Base;
    const bShip = b instanceof Player ? b : null;
    const bBase = isBBase ? (b as Base) : null;

    // A metrics
    const aPowerJ = a.power.chargeJ;
    const aMags = a.fire.mags;
    const aRcsTanks = a.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
    const aRcsFuel = aRcsTanks.reduce((sum, t) => sum + t.fuel, 0);
    const aRcsMaxFuel = aRcsTanks.reduce((sum, t) => sum + t.maxFuel, 0);

    // B metrics
    let bPowerJ = 0;
    let bMags = 0;
    let bRcsFuel = 0;
    let bRcsMaxFuel = 0;

    if (bShip) {
      bPowerJ = bShip.power.chargeJ;
      bMags = bShip.fire.mags;
      const bRcsTanks = bShip.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
      bRcsFuel = bRcsTanks.reduce((sum, t) => sum + t.fuel, 0);
      bRcsMaxFuel = bRcsTanks.reduce((sum, t) => sum + t.maxFuel, 0);
    } else if (bBase) {
      bPowerJ = C.POWER_CAPACITY * 10; // Unlimited / large base power supply
      bMags = 999; // Base has ample supply
      bRcsFuel = 10000;
      bRcsMaxFuel = 10000;
    }

    this.rootEl.innerHTML = `
      <div class="rt-panel">
        <div class="rt-header">
          <div>
            <h2 class="rt-title">物資・電力の融通</h2>
            <div class="rt-subtitle">${a.name} 🔗 ${bName}</div>
          </div>
          <button class="w-close rt-close-btn" title="閉じる">✕</button>
        </div>
        <div class="rt-body">

          <!-- 電力 (Power) -->
          <div class="rt-section">
            <div class="rt-section-head">⚡ 電力 (Power)</div>
            <div class="rt-grid">
              <div class="rt-card">
                <div class="rt-card-title">${a.name}</div>
                <div class="rt-metric"><span>蓄電量:</span> <span class="rt-metric-val">${fmtEnergy(aPowerJ)}</span></div>
              </div>
              <div class="rt-actions">
                <div class="rt-btn-group">
                  <button class="w-btn rt-btn-p-to-b" ${aPowerJ <= 0 ? 'disabled' : ''}>100kJ →</button>
                  <button class="w-btn rt-btn-p-to-a" ${isBBase ? '' : bPowerJ <= 0 ? 'disabled' : ''}>← 100kJ</button>
                </div>
                <div class="rt-btn-group">
                  <button class="w-btn rt-btn-p-all-b" ${aPowerJ <= 0 ? 'disabled' : ''}>全移動 →</button>
                  <button class="w-btn rt-btn-p-all-a" ${isBBase ? '' : bPowerJ <= 0 ? 'disabled' : ''}>← 満充電</button>
                </div>
              </div>
              <div class="rt-card">
                <div class="rt-card-title">${bName}</div>
                <div class="rt-metric"><span>蓄電量:</span> <span class="rt-metric-val">${isBBase ? '基地電源 (無限)' : fmtEnergy(bPowerJ)}</span></div>
              </div>
            </div>
          </div>

          <!-- 弾薬 (Ammo Magazines) -->
          <div class="rt-section">
            <div class="rt-section-head">📦 弾薬 (Magazines)</div>
            <div class="rt-grid">
              <div class="rt-card">
                <div class="rt-card-title">${a.name}</div>
                <div class="rt-metric"><span>予備マガジン:</span> <span class="rt-metric-val">${aMags} 個</span></div>
              </div>
              <div class="rt-actions">
                <div class="rt-btn-group">
                  <button class="w-btn rt-btn-m-to-b" ${aMags <= 0 ? 'disabled' : ''}>1 Mag →</button>
                  <button class="w-btn rt-btn-m-to-a" ${!isBBase && bMags <= 0 ? 'disabled' : ''}>← 1 Mag</button>
                </div>
                <div class="rt-btn-group">
                  <button class="w-btn rt-btn-m-all-b" ${aMags <= 0 ? 'disabled' : ''}>全 Mag →</button>
                  <button class="w-btn rt-btn-m-all-a" ${!isBBase && bMags <= 0 ? 'disabled' : ''}>← 補給</button>
                </div>
              </div>
              <div class="rt-card">
                <div class="rt-card-title">${bName}</div>
                <div class="rt-metric"><span>予備マガジン:</span> <span class="rt-metric-val">${isBBase ? '基地補給庫' : `${bMags} 個`}</span></div>
              </div>
            </div>
          </div>

          <!-- RCS 燃料 (RCS Fuel) -->
          <div class="rt-section">
            <div class="rt-section-head">🚀 RCS 燃料 (Fuel)</div>
            <div class="rt-grid">
              <div class="rt-card">
                <div class="rt-card-title">${a.name}</div>
                <div class="rt-metric"><span>RCS 燃料:</span> <span class="rt-metric-val">${aRcsFuel.toFixed(0)} / ${aRcsMaxFuel.toFixed(0)} kg</span></div>
              </div>
              <div class="rt-actions">
                <div class="rt-btn-group">
                  <button class="w-btn rt-btn-f-to-b" ${aRcsFuel <= 0 ? 'disabled' : ''}>10kg →</button>
                  <button class="w-btn rt-btn-f-to-a" ${!isBBase && bRcsFuel <= 0 ? 'disabled' : ''}>← 10kg</button>
                </div>
                <div class="rt-btn-group">
                  <button class="w-btn rt-btn-f-bal" ${isBBase ? '' : 'title="両艦の燃料比率を揃えます"'}>満タン補給 / 均等</button>
                </div>
              </div>
              <div class="rt-card">
                <div class="rt-card-title">${bName}</div>
                <div class="rt-metric"><span>RCS 燃料:</span> <span class="rt-metric-val">${isBBase ? '基地タンク' : `${bRcsFuel.toFixed(0)} / ${bRcsMaxFuel.toFixed(0)} kg`}</span></div>
              </div>
            </div>
          </div>

          <!-- パーツ・物資 (Inventory / Parts) -->
          ${isBBase ? `
          <div class="rt-section">
            <div class="rt-section-head">🧰 基地予備パーツ・物資 (Base Inventory)</div>
            <div class="rt-grid">
              <div class="rt-card">
                <div class="rt-card-title">${a.name} の構成パーツ</div>
                <div class="rt-inv-list">
                  ${a.parts.map((p) => `<div class="rt-inv-item"><span>${p.name} (${p.type})</span></div>`).join('')}
                </div>
              </div>
              <div class="rt-actions">
                <span class="rt-subtitle">※ パーツの換装・売却は基地格納後に行えます</span>
              </div>
              <div class="rt-card">
                <div class="rt-card-title">基地在庫 (${bBase!.baseState.inventory.length} 件)</div>
                <div class="rt-inv-list">
                  ${bBase!.baseState.inventory.length === 0
                    ? '<div class="rt-subtitle">在庫パーツなし</div>'
                    : bBase!.baseState.inventory.map((p) => `<div class="rt-inv-item"><span>${p.name} (${p.type})</span></div>`).join('')}
                </div>
              </div>
            </div>
          </div>
          ` : ''}

        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    const root = this.rootEl;
    const a = this.shipA;
    const b = this.entityB;
    if (!a || !b) return;

    const bShip = b instanceof Player ? b : null;
    const bBase = b instanceof Base ? b : null;

    root.querySelector('.rt-close-btn')?.addEventListener('click', () => this.close());

    // Power transfer A -> B
    root.querySelector('.rt-btn-p-to-b')?.addEventListener('click', () => {
      const amount = 100000; // 100 kJ
      const transferred = Math.min(amount, a.power.chargeJ);
      a.power.addChargeJ(-transferred);
      if (bShip) bShip.power.addChargeJ(transferred);
      this.render();
    });

    // Power transfer B -> A
    root.querySelector('.rt-btn-p-to-a')?.addEventListener('click', () => {
      const amount = 100000;
      if (bBase) {
        a.power.addChargeJ(amount);
      } else if (bShip) {
        const transferred = Math.min(amount, bShip.power.chargeJ);
        bShip.power.addChargeJ(-transferred);
        a.power.addChargeJ(transferred);
      }
      this.render();
    });

    // Power All A -> B
    root.querySelector('.rt-btn-p-all-b')?.addEventListener('click', () => {
      const transferred = a.power.chargeJ;
      a.power.setChargeJ(0);
      if (bShip) bShip.power.addChargeJ(transferred);
      this.render();
    });

    // Power Fill A
    root.querySelector('.rt-btn-p-all-a')?.addEventListener('click', () => {
      if (bBase) {
        a.power.setChargeJ(C.POWER_CAPACITY);
      } else if (bShip) {
        const needed = C.POWER_CAPACITY - a.power.chargeJ;
        const transferred = Math.min(needed, bShip.power.chargeJ);
        bShip.power.addChargeJ(-transferred);
        a.power.addChargeJ(transferred);
      }
      this.render();
    });

    // Mags transfer A -> B
    root.querySelector('.rt-btn-m-to-b')?.addEventListener('click', () => {
      if (a.fire.mags > 0) {
        a.fire.mags -= 1;
        if (bShip) bShip.fire.mags += 1;
        this.render();
      }
    });

    // Mags transfer B -> A
    root.querySelector('.rt-btn-m-to-a')?.addEventListener('click', () => {
      if (bBase) {
        a.fire.mags += 1;
        this.render();
      } else if (bShip && bShip.fire.mags > 0) {
        bShip.fire.mags -= 1;
        a.fire.mags += 1;
        this.render();
      }
    });

    // Mags all A -> B
    root.querySelector('.rt-btn-m-all-b')?.addEventListener('click', () => {
      if (bShip) bShip.fire.mags += a.fire.mags;
      a.fire.mags = 0;
      this.render();
    });

    // Mags fill A
    root.querySelector('.rt-btn-m-all-a')?.addEventListener('click', () => {
      if (bBase) {
        a.fire.mags = C.INITIAL_MAGS;
      } else if (bShip) {
        const transferred = bShip.fire.mags;
        a.fire.mags += transferred;
        bShip.fire.mags = 0;
      }
      this.render();
    });

    // Fuel transfer A -> B
    root.querySelector('.rt-btn-f-to-b')?.addEventListener('click', () => {
      this.transferRcsFuel(a, bShip, 10);
      this.render();
    });

    // Fuel transfer B -> A
    root.querySelector('.rt-btn-f-to-a')?.addEventListener('click', () => {
      if (bBase) {
        this.refillRcsFuel(a);
      } else if (bShip) {
        this.transferRcsFuel(bShip, a, 10);
      }
      this.render();
    });

    // Fuel balance / refill
    root.querySelector('.rt-btn-f-bal')?.addEventListener('click', () => {
      if (bBase) {
        this.refillRcsFuel(a);
      } else if (bShip) {
        this.balanceRcsFuel(a, bShip);
      }
      this.render();
    });
  }

  private refillRcsFuel(ship: Player): void {
    const tanks = ship.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
    for (const t of tanks) t.fuel = t.maxFuel;
  }

  private transferRcsFuel(from: Player, to: Player | null, amountKg: number): void {
    const fromTanks = from.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
    let available = fromTanks.reduce((s, t) => s + t.fuel, 0);
    const toTransfer = Math.min(amountKg, available);
    if (toTransfer <= 0) return;

    // Drain from `from`
    let leftToDrain = toTransfer;
    for (const t of fromTanks) {
      const drain = Math.min(t.fuel, leftToDrain);
      t.fuel -= drain;
      leftToDrain -= drain;
      if (leftToDrain <= 0) break;
    }

    // Add to `to` if present
    if (to) {
      const toTanks = to.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
      let leftToAdd = toTransfer;
      for (const t of toTanks) {
        const space = t.maxFuel - t.fuel;
        const add = Math.min(space, leftToAdd);
        t.fuel += add;
        leftToAdd -= add;
        if (leftToAdd <= 0) break;
      }
    }
  }

  private balanceRcsFuel(shipA: Player, shipB: Player): void {
    const tanksA = shipA.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
    const tanksB = shipB.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
    const totalFuel = tanksA.reduce((s, t) => s + t.fuel, 0) + tanksB.reduce((s, t) => s + t.fuel, 0);
    const totalMax = tanksA.reduce((s, t) => s + t.maxFuel, 0) + tanksB.reduce((s, t) => s + t.maxFuel, 0);
    if (totalMax <= 0) return;

    const ratio = totalFuel / totalMax;
    for (const t of tanksA) t.fuel = t.maxFuel * ratio;
    for (const t of tanksB) t.fuel = t.maxFuel * ratio;
  }
}
