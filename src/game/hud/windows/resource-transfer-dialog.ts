// ドッキング中の船同士で電力・物資(弾薬・RCS燃料)を融通するダイアログ。
import type { Player } from '../../player/player';
import { fmtEnergy } from '../utils';
import { injectOnce } from '../widgets/inject-style';
import { balanceRcsFuel, rcsFuelTotals, rcsTanksOf, transferRcsFuel } from './rcs-fuel-transfer';
import type { OverlayManager } from '../overlay-manager';
import { POWER_CAPACITY } from '../../player/power';

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
`;

// 電力の定量移送ボタン1回あたりの移送量 [J](100kJ)
const POWER_TRANSFER_STEP_J = 100000;

// RCS 燃料の定量移送ボタン1回あたりの移送量 [kg]
const RCS_FUEL_TRANSFER_STEP_KG = 10;

// 電力・弾薬・RCS燃料の残量をまとめて表す。
interface ResourceMetrics {
  readonly powerJ: number;
  readonly mags: number;
  readonly rcsFuel: number;
  readonly rcsMaxFuel: number;
}

export class ResourceTransferDialog {
  private readonly rootEl: HTMLElement;
  private isOpen = false;

  // ダイアログが開いている間だけ、融通対象の2隻を保持する(閉じている間は両方 null)。
  private shipA: Player | null = null;
  private shipB: Player | null = null;

  // ダイアログが閉じたときに呼ばれる。
  public onClose?: () => void;

  // DOM 要素を非表示状態で生成し、parent へ挿入する。
  public constructor(
    parent: HTMLElement,
    private readonly overlayManager?: OverlayManager,
  ) {
    injectOnce('resource-transfer-dialog', STYLE);

    this.rootEl = document.createElement('div');
    this.rootEl.id = 'resource-transfer-dialog';
    this.rootEl.className = 'rt-overlay';
    this.rootEl.style.display = 'none';
    parent.appendChild(this.rootEl);
  }

  // shipA と shipB の間で資源を融通できる状態にしてダイアログを開く。
  public open(shipA: Player, shipB: Player): void {
    this.shipA = shipA;
    this.shipB = shipB;
    this.isOpen = true;
    this.rootEl.style.display = 'flex';

    // モーダルとして登録し、Esc・外側クリック・背後入力の遮断を overlayManager に委ねる。
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

  // ダイアログを閉じ、onClose を通知する。開いていなければ何もしない。
  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.rootEl.style.display = 'none';
    if (this.overlayManager) {
      this.overlayManager.close('resource-transfer-dialog');
    }
    if (this.onClose) this.onClose();
  }

  // 電力・弾薬・RCS燃料の3区画を組み立てて表示を更新する。
  private render(): void {
    if (!this.shipA || !this.shipB) return;
    const a = this.shipA;
    const b = this.shipB;

    const aMetrics = this.computeMetrics(a);
    const bMetrics = this.computeMetrics(b);

    this.rootEl.innerHTML = `
      <div class="rt-panel">
        <div class="rt-header">
          <div>
            <h2 class="rt-title">物資・電力の融通</h2>
            <div class="rt-subtitle" data-role="subtitle"></div>
          </div>
          <button class="w-close rt-close-btn" title="閉じる">✕</button>
        </div>
        <div class="rt-body">
          ${this.renderPowerSection(aMetrics, bMetrics)}
          ${this.renderMagsSection(aMetrics, bMetrics)}
          ${this.renderRcsSection(aMetrics, bMetrics)}
        </div>
      </div>
    `;

    this.applyNames(a, b);
    this.bindEvents();
  }

  // 電力の残量表示と、定量移送・全移動・満充電のボタンを組み立てる。
  private renderPowerSection(aMetrics: ResourceMetrics, bMetrics: ResourceMetrics): string {
    const stepKj = POWER_TRANSFER_STEP_J / 1000;
    // 名前欄は空のまま返し、applyNames が艦名を textContent で反映する。
    return `
      <div class="rt-section">
        <div class="rt-section-head">⚡ 電力 (Power)</div>
        <div class="rt-grid">
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-a-name"></div>
            <div class="rt-metric"><span>蓄電量:</span> <span class="rt-metric-val">${fmtEnergy(aMetrics.powerJ)}</span></div>
          </div>
          <div class="rt-actions">
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-p-to-b" ${aMetrics.powerJ <= 0 ? 'disabled' : ''}>${stepKj}kJ →</button>
              <button class="w-btn rt-btn-p-to-a" ${bMetrics.powerJ <= 0 ? 'disabled' : ''}>← ${stepKj}kJ</button>
            </div>
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-p-all-b" ${aMetrics.powerJ <= 0 ? 'disabled' : ''}>全移動 →</button>
              <button class="w-btn rt-btn-p-all-a" ${bMetrics.powerJ <= 0 ? 'disabled' : ''}>← 満充電</button>
            </div>
          </div>
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-b-name"></div>
            <div class="rt-metric"><span>蓄電量:</span> <span class="rt-metric-val">${fmtEnergy(bMetrics.powerJ)}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // 弾薬(予備マガジン)の残量表示と、定量補充・全補給のボタンを組み立てる。
  private renderMagsSection(aMetrics: ResourceMetrics, bMetrics: ResourceMetrics): string {
    // 名前欄は空のまま返し、applyNames が艦名を textContent で反映する。
    return `
      <div class="rt-section">
        <div class="rt-section-head">📦 弾薬 (Magazines)</div>
        <div class="rt-grid">
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-a-name"></div>
            <div class="rt-metric"><span>予備マガジン:</span> <span class="rt-metric-val">${aMetrics.mags} 個</span></div>
          </div>
          <div class="rt-actions">
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-m-to-b" ${aMetrics.mags <= 0 ? 'disabled' : ''}>1 Mag →</button>
              <button class="w-btn rt-btn-m-to-a" ${bMetrics.mags <= 0 ? 'disabled' : ''}>← 1 Mag</button>
            </div>
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-m-all-b" ${aMetrics.mags <= 0 ? 'disabled' : ''}>全 Mag →</button>
              <button class="w-btn rt-btn-m-all-a" ${bMetrics.mags <= 0 ? 'disabled' : ''}>← 補給</button>
            </div>
          </div>
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-b-name"></div>
            <div class="rt-metric"><span>予備マガジン:</span> <span class="rt-metric-val">${bMetrics.mags} 個</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // RCS 燃料の残量表示と、定量移送・満タン補給/均等化のボタンを組み立てる。
  private renderRcsSection(aMetrics: ResourceMetrics, bMetrics: ResourceMetrics): string {
    // 名前欄は空のまま返し、applyNames が艦名を textContent で反映する。
    return `
      <div class="rt-section">
        <div class="rt-section-head">🚀 RCS 燃料 (Fuel)</div>
        <div class="rt-grid">
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-a-name"></div>
            <div class="rt-metric"><span>RCS 燃料:</span> <span class="rt-metric-val">${aMetrics.rcsFuel.toFixed(0)} / ${aMetrics.rcsMaxFuel.toFixed(0)} kg</span></div>
          </div>
          <div class="rt-actions">
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-f-to-b" ${aMetrics.rcsFuel <= 0 ? 'disabled' : ''}>${RCS_FUEL_TRANSFER_STEP_KG}kg →</button>
              <button class="w-btn rt-btn-f-to-a" ${bMetrics.rcsFuel <= 0 ? 'disabled' : ''}>← ${RCS_FUEL_TRANSFER_STEP_KG}kg</button>
            </div>
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-f-bal" title="両艦の燃料比率を揃えます">均等</button>
            </div>
          </div>
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-b-name"></div>
            <div class="rt-metric"><span>RCS 燃料:</span> <span class="rt-metric-val">${bMetrics.rcsFuel.toFixed(0)} / ${bMetrics.rcsMaxFuel.toFixed(0)} kg</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // render が生成したプレースホルダへ、改名可能な艦名を反映する。
  private applyNames(a: Player, b: Player): void {
    const bName = b.name || '他艦';
    const subtitleEl = this.rootEl.querySelector<HTMLElement>('[data-role="subtitle"]');
    if (subtitleEl) subtitleEl.textContent = `${a.name} 🔗 ${bName}`;

    for (const el of Array.from(this.rootEl.querySelectorAll<HTMLElement>('[data-role="entity-a-name"]'))) el.textContent = a.name;
    for (const el of Array.from(this.rootEl.querySelectorAll<HTMLElement>('[data-role="entity-b-name"]'))) el.textContent = bName;
  }

  // 各区画のボタンへクリックハンドラを配線する。
  private bindEvents(): void {
    const a = this.shipA;
    const b = this.shipB;
    if (!a || !b) return;

    this.rootEl.querySelector('.rt-close-btn')?.addEventListener('click', () => this.close());

    this.bindPowerEvents(a, b);
    this.bindMagsEvents(a, b);
    this.bindRcsEvents(a, b);
  }

  // 電力の定量双方向移送・全移動・満充電の4ボタンを配線する。
  private bindPowerEvents(a: Player, b: Player): void {
    this.rootEl.querySelector('.rt-btn-p-to-b')?.addEventListener('click', () => {
      const transferred = Math.min(POWER_TRANSFER_STEP_J, a.power.chargeJ);
      a.power.addChargeJ(-transferred);
      b.power.addChargeJ(transferred);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-p-to-a')?.addEventListener('click', () => {
      const transferred = Math.min(POWER_TRANSFER_STEP_J, b.power.chargeJ);
      b.power.addChargeJ(-transferred);
      a.power.addChargeJ(transferred);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-p-all-b')?.addEventListener('click', () => {
      const transferred = a.power.chargeJ;
      a.power.setChargeJ(0);
      b.power.addChargeJ(transferred);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-p-all-a')?.addEventListener('click', () => {
      const needed = POWER_CAPACITY - a.power.chargeJ;
      const transferred = Math.min(needed, b.power.chargeJ);
      b.power.addChargeJ(-transferred);
      a.power.addChargeJ(transferred);
      this.render();
    });
  }

  // 弾薬(予備マガジン)の定量双方向移送・全移動の4ボタンを配線する。
  private bindMagsEvents(a: Player, b: Player): void {
    this.rootEl.querySelector('.rt-btn-m-to-b')?.addEventListener('click', () => {
      if (a.fire.mags > 0) {
        a.fire.mags -= 1;
        b.fire.mags += 1;
        this.render();
      }
    });

    this.rootEl.querySelector('.rt-btn-m-to-a')?.addEventListener('click', () => {
      if (b.fire.mags > 0) {
        b.fire.mags -= 1;
        a.fire.mags += 1;
        this.render();
      }
    });

    this.rootEl.querySelector('.rt-btn-m-all-b')?.addEventListener('click', () => {
      b.fire.mags += a.fire.mags;
      a.fire.mags = 0;
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-m-all-a')?.addEventListener('click', () => {
      a.fire.mags += b.fire.mags;
      b.fire.mags = 0;
      this.render();
    });
  }

  // RCS 燃料の定量双方向移送・均等化のボタンを配線する。
  private bindRcsEvents(a: Player, b: Player): void {
    this.rootEl.querySelector('.rt-btn-f-to-b')?.addEventListener('click', () => {
      transferRcsFuel(a, b, RCS_FUEL_TRANSFER_STEP_KG);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-f-to-a')?.addEventListener('click', () => {
      transferRcsFuel(b, a, RCS_FUEL_TRANSFER_STEP_KG);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-f-bal')?.addEventListener('click', () => {
      balanceRcsFuel(a, b);
      this.render();
    });
  }

  // entity の電力・弾薬・RCS燃料の残量をまとめて返す。
  private computeMetrics(entity: Player): ResourceMetrics {
    const totals = rcsFuelTotals(rcsTanksOf(entity));
    return {
      powerJ: entity.power.chargeJ,
      mags: entity.fire.mags,
      rcsFuel: totals.fuel,
      rcsMaxFuel: totals.maxFuel,
    };
  }

}
