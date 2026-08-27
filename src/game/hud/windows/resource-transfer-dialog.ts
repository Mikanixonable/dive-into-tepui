// ドッキング中の船同士・船と基地の間で電力・物資(弾薬・RCS燃料・パーツ)を融通するダイアログ。
import { Player } from '../../player/player';
import { Base } from '../../game-entity/base';
import * as C from '../../const';
import { fmtEnergy } from '../utils';
import { injectOnce } from '../widgets/inject-style';
import type { GameEntity } from '../../game-entity/game-entity';
import type { Part, RcsTankPart } from '../../game-entity/parts';
import type { OverlayManager } from '../overlay-manager';

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

// isBBase のとき参照されないプレースホルダ値。
const EMPTY_METRICS: ResourceMetrics = { powerJ: 0, mags: 0, rcsFuel: 0, rcsMaxFuel: 0 };

export class ResourceTransferDialog {
  private readonly rootEl: HTMLElement;
  private isOpen = false;

  // ダイアログが開いている間だけ、融通対象の2者を保持する(閉じている間は両方 null)。
  private shipA: Player | null = null;
  private entityB: GameEntity | null = null;

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

  // shipA と entityB の間で資源を融通できる状態にしてダイアログを開く。
  public open(shipA: Player, entityB: GameEntity): void {
    this.shipA = shipA;
    this.entityB = entityB;
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

  // 電力・弾薬・RCS燃料・(基地なら)在庫パーツの4区画を組み立てて表示を更新する。
  private render(): void {
    if (!this.shipA || !this.entityB) return;
    const a = this.shipA;
    const b = this.entityB;

    // 相手が基地か艦かで、資源上限や表示文言の扱いが分岐する。
    const bName = b.name || (b instanceof Base ? '基地' : '他艦');
    const isBBase = b instanceof Base;
    const bShip = b instanceof Player ? b : null;
    const bBase = isBBase ? (b as Base) : null;

    const aMetrics = this.computeMetrics(a);
    const bMetrics = bShip ? this.computeMetrics(bShip) : EMPTY_METRICS;

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
          ${this.renderPowerSection(aMetrics, bMetrics, isBBase)}
          ${this.renderMagsSection(aMetrics, bMetrics, isBBase)}
          ${this.renderRcsSection(aMetrics, bMetrics, isBBase)}
          ${isBBase ? this.renderBaseInventorySection(bBase!) : ''}
        </div>
      </div>
    `;

    this.applyNames(a, bName, isBBase);
    if (isBBase) this.fillBaseInventoryLists(a, bBase!);
    this.bindEvents();
  }

  // 電力の残量表示と、定量移送・全移動・満充電のボタンを組み立てる。
  private renderPowerSection(aMetrics: ResourceMetrics, bMetrics: ResourceMetrics, isBBase: boolean): string {
    const stepKj = POWER_TRANSFER_STEP_J / 1000;
    // 名前欄は空のまま返し、applyNames が艦名・基地名を textContent で反映する。
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
              <button class="w-btn rt-btn-p-to-a" ${isBBase ? '' : bMetrics.powerJ <= 0 ? 'disabled' : ''}>← ${stepKj}kJ</button>
            </div>
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-p-all-b" ${aMetrics.powerJ <= 0 ? 'disabled' : ''}>全移動 →</button>
              <button class="w-btn rt-btn-p-all-a" ${isBBase ? '' : bMetrics.powerJ <= 0 ? 'disabled' : ''}>← 満充電</button>
            </div>
          </div>
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-b-name"></div>
            <div class="rt-metric"><span>蓄電量:</span> <span class="rt-metric-val">${isBBase ? '基地電源 (無限)' : fmtEnergy(bMetrics.powerJ)}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // 弾薬(予備マガジン)の残量表示と、定量補充・全補給のボタンを組み立てる。
  private renderMagsSection(aMetrics: ResourceMetrics, bMetrics: ResourceMetrics, isBBase: boolean): string {
    // 名前欄は空のまま返し、applyNames が艦名・基地名を textContent で反映する。
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
              <button class="w-btn rt-btn-m-to-a" ${!isBBase && bMetrics.mags <= 0 ? 'disabled' : ''}>← 1 Mag</button>
            </div>
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-m-all-b" ${aMetrics.mags <= 0 ? 'disabled' : ''}>全 Mag →</button>
              <button class="w-btn rt-btn-m-all-a" ${!isBBase && bMetrics.mags <= 0 ? 'disabled' : ''}>← 補給</button>
            </div>
          </div>
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-b-name"></div>
            <div class="rt-metric"><span>予備マガジン:</span> <span class="rt-metric-val">${isBBase ? '基地補給庫' : `${bMetrics.mags} 個`}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // RCS 燃料の残量表示と、定量移送・満タン補給/均等化のボタンを組み立てる。
  private renderRcsSection(aMetrics: ResourceMetrics, bMetrics: ResourceMetrics, isBBase: boolean): string {
    // 名前欄は空のまま返し、applyNames が艦名・基地名を textContent で反映する。
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
              <button class="w-btn rt-btn-f-to-a" ${!isBBase && bMetrics.rcsFuel <= 0 ? 'disabled' : ''}>← ${RCS_FUEL_TRANSFER_STEP_KG}kg</button>
            </div>
            <div class="rt-btn-group">
              <button class="w-btn rt-btn-f-bal" ${isBBase ? '' : 'title="両艦の燃料比率を揃えます"'}>満タン補給 / 均等</button>
            </div>
          </div>
          <div class="rt-card">
            <div class="rt-card-title" data-role="entity-b-name"></div>
            <div class="rt-metric"><span>RCS 燃料:</span> <span class="rt-metric-val">${isBBase ? '基地タンク' : `${bMetrics.rcsFuel.toFixed(0)} / ${bMetrics.rcsMaxFuel.toFixed(0)} kg`}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // 基地とドッキング中のときだけ、双方の保有パーツ一覧を並べて表示する枠を組み立てる。
  private renderBaseInventorySection(bBase: Base): string {
    // 名前欄と一覧欄は空のまま返し、applyNames / fillBaseInventoryLists が中身を反映する。
    return `
      <div class="rt-section">
        <div class="rt-section-head">🧰 基地予備パーツ・物資 (Base Inventory)</div>
        <div class="rt-grid">
          <div class="rt-card">
            <div class="rt-card-title" data-role="parts-a-name"></div>
            <div class="rt-inv-list" data-role="a-parts-list"></div>
          </div>
          <div class="rt-actions">
            <span class="rt-subtitle">※ パーツの換装・売却は基地格納後に行えます</span>
          </div>
          <div class="rt-card">
            <div class="rt-card-title">基地在庫 (${bBase.baseState.inventory.length} 件)</div>
            <div class="rt-inv-list" data-role="b-parts-list"></div>
          </div>
        </div>
      </div>
    `;
  }

  // render が生成したプレースホルダへ、改名可能な艦名・基地名を反映する。
  private applyNames(a: Player, bName: string, isBBase: boolean): void {
    const subtitleEl = this.rootEl.querySelector<HTMLElement>('[data-role="subtitle"]');
    if (subtitleEl) subtitleEl.textContent = `${a.name} 🔗 ${bName}`;

    this.rootEl.querySelectorAll<HTMLElement>('[data-role="entity-a-name"]').forEach((el) => { el.textContent = a.name; });
    this.rootEl.querySelectorAll<HTMLElement>('[data-role="entity-b-name"]').forEach((el) => { el.textContent = bName; });

    if (!isBBase) return;
    const partsTitleEl = this.rootEl.querySelector<HTMLElement>('[data-role="parts-a-name"]');
    if (partsTitleEl) partsTitleEl.textContent = `${a.name} の構成パーツ`;
  }

  // 基地在庫セクションの両リストへ、自艦の構成パーツと基地在庫パーツを一覧として反映する。
  private fillBaseInventoryLists(a: Player, bBase: Base): void {
    const aListEl = this.rootEl.querySelector<HTMLElement>('[data-role="a-parts-list"]');
    if (aListEl) this.populateInventoryList(aListEl, a.parts);

    // 在庫が空のときは一覧の代わりに空メッセージを表示する。
    const bListEl = this.rootEl.querySelector<HTMLElement>('[data-role="b-parts-list"]');
    if (!bListEl) return;
    if (bBase.baseState.inventory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rt-subtitle';
      empty.textContent = '在庫パーツなし';
      bListEl.appendChild(empty);
    } else {
      this.populateInventoryList(bListEl, bBase.baseState.inventory);
    }
  }

  // parts の各要素を一覧行として container へ追加する。
  private populateInventoryList(container: HTMLElement, parts: readonly Part[]): void {
    for (const p of parts) {
      const item = document.createElement('div');
      item.className = 'rt-inv-item';
      const label = document.createElement('span');
      label.textContent = `${p.name} (${p.type})`;
      item.appendChild(label);
      container.appendChild(item);
    }
  }

  // 各区画のボタンへクリックハンドラを配線する。
  private bindEvents(): void {
    const a = this.shipA;
    const b = this.entityB;
    if (!a || !b) return;

    const bShip = b instanceof Player ? b : null;
    const bBase = b instanceof Base ? b : null;

    this.rootEl.querySelector('.rt-close-btn')?.addEventListener('click', () => this.close());

    this.bindPowerEvents(a, bShip, bBase);
    this.bindMagsEvents(a, bShip, bBase);
    this.bindRcsEvents(a, bShip, bBase);
  }

  // 電力の定量双方向移送・全移動・満充電の4ボタンを配線する。
  private bindPowerEvents(a: Player, bShip: Player | null, bBase: Base | null): void {
    // いずれの操作も、B が基地なら供給元を無制限として扱う。
    this.rootEl.querySelector('.rt-btn-p-to-b')?.addEventListener('click', () => {
      const transferred = Math.min(POWER_TRANSFER_STEP_J, a.power.chargeJ);
      a.power.addChargeJ(-transferred);
      if (bShip) bShip.power.addChargeJ(transferred);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-p-to-a')?.addEventListener('click', () => {
      if (bBase) {
        a.power.addChargeJ(POWER_TRANSFER_STEP_J);
      } else if (bShip) {
        const transferred = Math.min(POWER_TRANSFER_STEP_J, bShip.power.chargeJ);
        bShip.power.addChargeJ(-transferred);
        a.power.addChargeJ(transferred);
      }
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-p-all-b')?.addEventListener('click', () => {
      const transferred = a.power.chargeJ;
      a.power.setChargeJ(0);
      if (bShip) bShip.power.addChargeJ(transferred);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-p-all-a')?.addEventListener('click', () => {
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
  }

  // 弾薬(予備マガジン)の定量双方向移送・全移動・全補給の4ボタンを配線する。
  private bindMagsEvents(a: Player, bShip: Player | null, bBase: Base | null): void {
    // いずれの操作も、B が基地なら供給元を無制限として扱う。
    this.rootEl.querySelector('.rt-btn-m-to-b')?.addEventListener('click', () => {
      if (a.fire.mags > 0) {
        a.fire.mags -= 1;
        if (bShip) bShip.fire.mags += 1;
        this.render();
      }
    });

    this.rootEl.querySelector('.rt-btn-m-to-a')?.addEventListener('click', () => {
      if (bBase) {
        a.fire.mags += 1;
        this.render();
      } else if (bShip && bShip.fire.mags > 0) {
        bShip.fire.mags -= 1;
        a.fire.mags += 1;
        this.render();
      }
    });

    this.rootEl.querySelector('.rt-btn-m-all-b')?.addEventListener('click', () => {
      if (bShip) bShip.fire.mags += a.fire.mags;
      a.fire.mags = 0;
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-m-all-a')?.addEventListener('click', () => {
      if (bBase) {
        a.fire.mags = C.INITIAL_MAGS;
      } else if (bShip) {
        const transferred = bShip.fire.mags;
        a.fire.mags += transferred;
        bShip.fire.mags = 0;
      }
      this.render();
    });
  }

  // RCS 燃料の定量双方向移送・満タン補給/均等化のボタンを配線する。
  private bindRcsEvents(a: Player, bShip: Player | null, bBase: Base | null): void {
    // B が基地のときは、受け取り側の操作をすべて自艦の満タン補給として扱う。
    this.rootEl.querySelector('.rt-btn-f-to-b')?.addEventListener('click', () => {
      this.transferRcsFuel(a, bShip, RCS_FUEL_TRANSFER_STEP_KG);
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-f-to-a')?.addEventListener('click', () => {
      if (bBase) {
        this.refillRcsFuel(a);
      } else if (bShip) {
        this.transferRcsFuel(bShip, a, RCS_FUEL_TRANSFER_STEP_KG);
      }
      this.render();
    });

    this.rootEl.querySelector('.rt-btn-f-bal')?.addEventListener('click', () => {
      if (bBase) {
        this.refillRcsFuel(a);
      } else if (bShip) {
        this.balanceRcsFuel(a, bShip);
      }
      this.render();
    });
  }

  // 指定した艦の RCS タンクをすべて満タンにする。
  private refillRcsFuel(ship: Player): void {
    for (const t of this.rcsTanksOf(ship)) t.fuel = t.maxFuel;
  }

  // from のタンクを残量がある順に消費し、to のタンクへ空き容量がある順に注ぐことで、
  // 複数タンクをまたいだ amountKg [kg] の移送を行う。to が null なら from から失うだけにする。
  private transferRcsFuel(from: Player, to: Player | null, amountKg: number): void {
    const fromTanks = this.rcsTanksOf(from);
    const available = fromTanks.reduce((s, t) => s + t.fuel, 0);
    const toTransfer = Math.min(amountKg, available);
    if (toTransfer <= 0) return;

    let leftToDrain = toTransfer;
    for (const t of fromTanks) {
      const drain = Math.min(t.fuel, leftToDrain);
      t.fuel -= drain;
      leftToDrain -= drain;
      if (leftToDrain <= 0) break;
    }

    if (!to) return;
    // to 側のタンクへ、空き容量がある順に注ぎ込む。
    const toTanks = this.rcsTanksOf(to);
    let leftToAdd = toTransfer;
    for (const t of toTanks) {
      const space = t.maxFuel - t.fuel;
      const add = Math.min(space, leftToAdd);
      t.fuel += add;
      leftToAdd -= add;
      if (leftToAdd <= 0) break;
    }
  }

  // 両者の RCS 燃料を合算し、双方が同じ充填率になるよう再配分する。
  private balanceRcsFuel(shipA: Player, shipB: Player): void {
    const tanksA = this.rcsTanksOf(shipA);
    const tanksB = this.rcsTanksOf(shipB);
    const totalFuel = tanksA.reduce((s, t) => s + t.fuel, 0) + tanksB.reduce((s, t) => s + t.fuel, 0);
    const totalMax = tanksA.reduce((s, t) => s + t.maxFuel, 0) + tanksB.reduce((s, t) => s + t.maxFuel, 0);
    if (totalMax <= 0) return;

    const ratio = totalFuel / totalMax;
    for (const t of tanksA) t.fuel = t.maxFuel * ratio;
    for (const t of tanksB) t.fuel = t.maxFuel * ratio;
  }

  // entity の電力・弾薬・RCS燃料の残量をまとめて返す。
  private computeMetrics(entity: Player): ResourceMetrics {
    const tanks = this.rcsTanksOf(entity);
    return {
      powerJ: entity.power.chargeJ,
      mags: entity.fire.mags,
      rcsFuel: tanks.reduce((sum, t) => sum + t.fuel, 0),
      rcsMaxFuel: tanks.reduce((sum, t) => sum + t.maxFuel, 0),
    };
  }

  // entity が搭載する RCS タンクを取り出す。
  private rcsTanksOf(entity: Player): readonly RcsTankPart[] {
    return entity.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
  }
}
