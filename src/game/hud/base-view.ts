// ドックビュー: 基地に接岸した際に開くフルスクリーンUI。
// 格納されている船の一覧、部品の確認・修理・換装、ショップを提供する。
import type { Base, DockedShipEntry } from '../game-entity/base';
import type { Player } from '../player/player';
import type { AnyPart, Part, PartType, RcsTankPart } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';
import * as C from '../const';
import { Button, CloseButton, Meter, TabBar } from './widgets';
import { MQ_COMPACT, MQ_SHORT } from './breakpoints';

const STYLE = `
/* 戦闘・マップと対等な全画面ビュー。情報面は Solid を基調にし、
   選択中の艦とその整備コンテキストだけ Focus Glass へ持ち上げる。 */
#base-view.base-view-overlay {
  position: fixed; inset: 0;
  display: flex;
  box-sizing: border-box;
  background: var(--page);
  color: var(--body);
  font-family: var(--font-neutral, var(--font-family));
  pointer-events: auto;
  padding: max(var(--space-6), var(--safe-t)) max(var(--space-5), var(--safe-r)) max(var(--space-5), var(--safe-b)) max(var(--space-5), var(--safe-l));
}
#base-view .dock-panel {
  width: min(100%, 1160px); min-width: 0; min-height: 0; margin: 0 auto;
  display: flex; flex-direction: column;
}
#base-view .dock-header {
  display: grid; grid-template-columns: minmax(180px, 0.72fr) minmax(300px, 1.4fr) auto;
  align-items: center; gap: var(--space-6);
  flex: 0 0 auto; padding: 15px 17px 11px;
  border-radius: var(--radius-window) var(--radius-window) 0 0;
  background: var(--surface-1);
}
#base-view .dock-title-group { min-width: 0; }
#base-view .dock-kicker {
  display: block; margin-bottom: var(--space-2);
  color: var(--accent); font-size: var(--font-xs); line-height: 1.3;
}
#base-view .dock-title {
  display: block; margin: 0; color: var(--title);
  font-size: var(--font-2xl); font-weight: 500; line-height: 1; letter-spacing: -0.035em;
}
#base-view .dock-subtitle {
  display: block; margin-top: var(--space-2);
  color: var(--muted); font-size: var(--font-s); line-height: 1.4;
}
#base-view .dock-tabs { min-width: 0; justify-content: center; }
#base-view .dock-tabs .w-btn {
  min-height: 34px; padding: 7px 11px;
  border: 0; border-radius: var(--radius-control);
  background: transparent; color: var(--muted);
}
#base-view .dock-tabs .w-btn:hover { background: var(--surface-2); color: var(--accent-near); }
#base-view .dock-tabs .w-btn.on { background: var(--accent-fill); color: var(--accent); }
#base-view .w-close {
  width: 34px; height: 34px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--muted);
}
#base-view .w-close:hover { background: var(--surface-3); color: var(--accent-near); }
#base-view .dock-status-bar {
  flex: 0 0 auto; padding: 0 17px 13px;
  border-radius: 0 0 var(--radius-window) var(--radius-window);
  background: var(--surface-1); color: var(--muted);
  font-size: var(--font-s); font-variant-numeric: tabular-nums;
}
#base-view .dock-status-bar::before {
  content: "∗"; margin-right: var(--space-3); color: var(--accent-secondary);
}
#base-view .dock-body {
  flex: 1 1 0; min-height: 0; margin-top: 9px; padding: var(--space-6) 0;
  overflow-y: auto; scrollbar-width: thin; outline: none;
}
#base-view .dock-body:focus-visible,
#base-view .dock-ship-select:focus-visible,
#base-view .dock-part-swap-select:focus-visible,
#base-view .w-btn:focus-visible,
#base-view .w-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
#base-view .dock-section { display: flex; flex-direction: column; gap: 9px; }
#base-view .dock-section-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-6);
  padding: 0 var(--space-2) var(--space-5);
}
#base-view .dock-section-copy { min-width: 0; }
#base-view .dock-section-title {
  margin: 0; color: var(--title); font-size: var(--font-xl); font-weight: 600; line-height: 1.3;
}
#base-view .dock-section-description {
  margin: var(--space-2) 0 0; color: var(--muted); font-size: var(--font-s); line-height: 1.55;
}
#base-view .dock-section-count {
  flex: 0 0 auto; padding: 5px 8px; border-radius: var(--radius-control);
  background: var(--surface-1); color: var(--muted); font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
#base-view .dock-empty {
  padding: var(--space-6); border-radius: var(--radius-panel);
  background: var(--surface-1); color: var(--muted); text-align: center; line-height: 1.8;
}
/* Ships tab */
#base-view .dock-ship-list { display: flex; flex-direction: column; gap: 7px; }
#base-view .dock-ship-row {
  position: relative; display: flex; align-items: center; gap: var(--space-5);
  padding: 9px 12px; border-radius: var(--radius-panel); background: var(--surface-1);
  transition: color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}
#base-view .dock-ship-row:hover:not(.is-selected) { background: var(--surface-2); }
#base-view .dock-ship-row.is-selected {
  background: var(--glass-focus); backdrop-filter: blur(20px) saturate(82%);
  -webkit-backdrop-filter: blur(20px) saturate(82%);
  box-shadow: 0 16px 48px var(--shadow, var(--shade-1));
}
#base-view .dock-ship-row.is-selected::before {
  content: ""; position: absolute; top: 12px; bottom: 12px; left: 6px; width: 3px;
  border-radius: var(--radius-control); background: var(--accent);
}
#base-view .dock-ship-select {
  flex: 1 1 auto; min-width: 0; display: block; padding: var(--space-3) var(--space-4);
  border: 0; border-radius: var(--radius-control); background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
#base-view .dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-ship-name { color: var(--title); font-size: var(--font-l); font-weight: 500; }
#base-view .dock-ship-row:not(.is-selected) .dock-ship-select:hover .dock-ship-name { color: var(--accent-near); }
#base-view .dock-ship-row.is-selected .dock-ship-name { color: var(--accent); }
#base-view .dock-ship-hp { color: var(--muted); font-size: var(--font-s); font-variant-numeric: tabular-nums; }
#base-view .dock-ship-row.is-critical .dock-ship-hp { color: var(--danger); }
#base-view .dock-ship-actions { display: flex; flex: 0 0 auto; gap: 5px; }
/* Parts tab */
#base-view .dock-parts-header {
  display: flex; align-items: center; gap: var(--space-5); padding: 11px 13px;
  border-radius: var(--radius-panel); background: var(--surface-1);
}
#base-view .dock-parts-header.dock-focus-panel {
  background: var(--glass-focus); backdrop-filter: blur(20px) saturate(82%);
  -webkit-backdrop-filter: blur(20px) saturate(82%);
  box-shadow: 0 16px 48px var(--shadow, var(--shade-1));
}
#base-view .dock-ship-label { flex: 1; color: var(--body); font-size: var(--font-m); }
#base-view .dock-ship-label strong { color: var(--accent); font-weight: 600; }
#base-view .dock-part-list { display: flex; flex-direction: column; gap: 7px; }
#base-view .dock-part-row {
  display: flex; flex-direction: column; gap: var(--space-3); padding: 9px 11px;
  border-radius: var(--radius-panel); background: var(--surface-2);
}
#base-view .dock-part-info { display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-part-name { color: var(--title); font-size: var(--font-m); font-weight: 500; }
#base-view .dock-part-type { color: var(--muted); font-size: var(--font-xs); }
#base-view .dock-part-hp-meter .w-meter-track { height: 7px; border-radius: var(--radius-control); overflow: hidden; }
#base-view .dock-part-hp-meter .w-meter-fill { border-radius: var(--radius-control); transition: width var(--transition-slow); }
#base-view .dock-part-hp-text { color: var(--muted); font-size: var(--font-s); text-align: right; font-variant-numeric: tabular-nums; }
#base-view .dock-part-row-main {
  display: grid; grid-template-columns: minmax(120px, 1fr) minmax(96px, 140px);
  align-items: center; gap: var(--space-5);
}
#base-view .dock-warehouse-row-main { grid-template-columns: minmax(120px, 1fr) auto; }
#base-view .dock-part-actions {
  grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 5px; flex-wrap: wrap;
}
#base-view .dock-part-swap-row {
  display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3);
  border-radius: var(--radius-control); background: var(--surface-1);
  color: var(--muted); font-size: var(--font-s);
}
#base-view .dock-part-swap-select {
  flex: 1; min-width: 0; padding: 7px 9px;
  border: 0; border-radius: var(--radius-control);
  background: var(--surface-3); color: var(--title); font: inherit; font-size: var(--font-s);
}
#base-view .dock-parts-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
#base-view .dock-parts-col {
  display: flex; flex-direction: column; gap: var(--space-4); min-width: 0;
  padding: 13px; border-radius: var(--radius-window); background: var(--surface-1);
}
#base-view .dock-col-title { margin: 0; color: var(--title); font-size: var(--font-m); font-weight: 600; }
/* Shop tab */
#base-view .dock-shop-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
#base-view .dock-shop-item {
  display: flex; align-items: center; gap: var(--space-5); min-width: 0; padding: 11px 13px;
  border-radius: var(--radius-panel); background: var(--surface-1);
}
#base-view .dock-shop-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-shop-name { color: var(--title); font-size: var(--font-l); font-weight: 500; }
#base-view .dock-shop-type { color: var(--muted); font-size: var(--font-xs); }
#base-view .dock-shop-props { color: var(--body); font-size: var(--font-s); line-height: 1.45; }
#base-view .dock-shop-stats { color: var(--muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
#base-view .dock-shop-actions { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2); }
#base-view .dock-shop-price { color: var(--title); font-size: var(--font-m); font-variant-numeric: tabular-nums; }
/* ドック内の操作は Borderless。主要操作、サービス完了系、補助操作の三段に分ける。 */
#base-view span.dock-btn {
  padding: 7px 10px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--body); white-space: nowrap;
}
#base-view span.dock-btn:hover { background: var(--surface-3); color: var(--accent-near); }
#base-view span.dock-btn-primary { background: var(--accent-fill); color: var(--accent); }
#base-view span.dock-btn-primary:hover { background: var(--accent-fill-strong); color: var(--accent-near); }
#base-view span.dock-btn-service { color: var(--body); }
#base-view span.dock-btn-service:hover { background: var(--surface-3); color: var(--accent-near); }
#base-view span.dock-btn-complete.disabled { opacity: 0.72; color: var(--accent-secondary); }
#base-view span.dock-btn-quiet { color: var(--muted); }

@media ${MQ_COMPACT} {
  #base-view.base-view-overlay {
    align-items: flex-end; padding: max(var(--space-4), var(--safe-t)) 0 0;
  }
  #base-view .dock-panel {
    height: 94dvh; max-height: 100%; overflow: hidden; border-radius: var(--radius-window) var(--radius-window) 0 0;
    background: var(--surface-0);
  }
  #base-view .dock-header {
    grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4);
    padding: 13px 13px 9px;
  }
  #base-view .dock-title { font-size: var(--font-xl); }
  #base-view .dock-subtitle { display: none; }
  #base-view .dock-tabs {
    grid-column: 1 / -1; grid-row: 2; justify-content: flex-start;
    overflow-x: auto; scrollbar-width: none;
  }
  #base-view .dock-tabs::-webkit-scrollbar { display: none; }
  #base-view .dock-tabs .w-btn { flex: 1 0 auto; text-align: center; }
  #base-view .dock-status-bar { padding: 0 13px 11px; }
  #base-view .dock-body { margin-top: 0; padding: 13px; }
  #base-view .dock-section-head { align-items: flex-start; padding-inline: 0; }
  #base-view .dock-ship-row { align-items: stretch; flex-direction: column; gap: var(--space-3); }
  #base-view .dock-ship-actions { display: grid; grid-template-columns: 1fr 1fr; }
  #base-view .dock-ship-actions .dock-btn { justify-content: center; text-align: center; }
  #base-view .dock-parts-header { align-items: flex-start; flex-direction: column; }
  #base-view .dock-parts-header .dock-btn { align-self: stretch; text-align: center; }
  #base-view .dock-parts-columns, #base-view .dock-shop-list { grid-template-columns: 1fr; }
  #base-view .dock-parts-col { padding: 11px; }
  #base-view .dock-part-row-main { grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4); }
  #base-view .dock-part-row-main:not(.dock-warehouse-row-main) .dock-part-hp-meter { grid-column: 1 / -1; grid-row: 2; }
  #base-view .dock-warehouse-row-main .dock-part-actions { grid-column: 1 / -1; justify-content: flex-end; }
  #base-view .dock-part-swap-row { align-items: stretch; flex-wrap: wrap; }
  #base-view .dock-part-swap-select { flex-basis: calc(100% - 80px); }
  #base-view .dock-shop-item { align-items: stretch; flex-direction: column; }
  #base-view .dock-shop-actions { align-items: center; flex-direction: row; justify-content: space-between; }
}

@media ${MQ_SHORT} {
  #base-view.base-view-overlay { padding-top: var(--space-3); }
  #base-view .dock-header { padding-top: 9px; padding-bottom: 7px; }
  #base-view .dock-subtitle { display: none; }
  #base-view .dock-status-bar { padding-bottom: 9px; }
  #base-view .dock-body { padding-top: 9px; padding-bottom: 9px; }
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

const PART_TYPE_LABELS: Readonly<Record<PartType, string>> = {
  hull: '船体',
  cockpit: '操縦区画',
  armor: '装甲',
  thruster: 'RCS 推進器',
  rcs_tank: 'RCS タンク',
  radiator: '放熱器',
  solar_panel: '太陽電池',
  weapon: '武装',
};

function formatPartMeta(part: Part): string {
  if (part.type !== 'rcs_tank') return PART_TYPE_LABELS[part.type];
  const tank = part as RcsTankPart;
  return `${PART_TYPE_LABELS[part.type]} · 燃料 ${Math.round(tank.fuel).toLocaleString()} / ${Math.round(tank.maxFuel).toLocaleString()} kg`;
}

function formatCatalogProperty(name: string, value: number | string): string {
  switch (name) {
    case 'damageReduction': return `被害軽減 ${typeof value === 'number' ? Math.round(value * 100) : value} %`;
    case 'torque': return `トルク ${Number(value).toLocaleString()} N·m`;
    case 'thrust': return `推力 ${Number(value).toLocaleString()} N`;
    case 'fuelConsumptionRate': return `燃料消費 ${value} kg/s`;
    case 'maxFuel': return `燃料容量 ${Number(value).toLocaleString()} kg`;
    case 'fuel': return `初期燃料 ${Number(value).toLocaleString()} kg`;
    case 'coolingRate': return `冷却性能 ${value}`;
    case 'powerGeneration': return `発電 ${Number(value).toLocaleString()} W`;
    case 'weaponType': {
      const weaponTypeLabel = value === 'gatling' ? 'ガトリング' : value === 'cannon' ? 'キャノン' : value;
      return `武器形式 ${weaponTypeLabel}`;
    }
    case 'fireRate': return `発射速度 ${value} 発/s`;
    case 'damage': return `威力 ${value}`;
    case 'muzzleVelocity': return `初速 ${Number(value).toLocaleString()} m/s`;
    default: return `${name} ${value}`;
  }
}

export class BaseView {
  private readonly el: HTMLElement;
  private readonly tabBar: TabBar<DockTab>;
  private readonly moneyLabel: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private _visible = false;
  private currentBase: Base | null = null;
  private currentShip: Player | null = null;
  private currentTab: DockTab = 'ships';
  private freeProcurement = false;
  private previouslyFocused: HTMLElement | null = null;

  // 外部コールバック
  public onLaunchShip: ((ship: Player, base: Base) => void) | null = null;
  // 「新造」ボタン。実際の艦の生成は Docking 側が行う(BaseView は UI のみ)。
  public onBuildShip: ((base: Base) => void) | null = null;
  public onClose: (() => void) | null = null;

  public get visible(): boolean { return this._visible; }
  public get element(): HTMLElement { return this.el; }

  public constructor(root: HTMLElement) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.id = 'base-view';
    this.el.className = 'base-view-overlay';
    this.el.style.display = 'none';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'base-view-title');
    this.el.addEventListener('keydown', (event) => this.trapFocus(event));

    const panel = document.createElement('div');
    panel.className = 'dock-panel';

    const header = document.createElement('header');
    header.className = 'dock-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'dock-title-group';
    const kicker = document.createElement('span');
    kicker.className = 'dock-kicker';
    kicker.textContent = 'Base operations';
    const title = document.createElement('h1');
    title.id = 'base-view-title';
    title.className = 'dock-title';
    title.textContent = 'Base';
    const subtitle = document.createElement('span');
    subtitle.className = 'dock-subtitle';
    subtitle.textContent = '艦の整備、補給、調達';
    titleGroup.append(kicker, title, subtitle);
    header.appendChild(titleGroup);

    this.tabBar = new TabBar<DockTab>(TAB_ITEMS, (tab) => {
      this.currentTab = tab;
      this.refresh();
    });
    this.tabBar.element.classList.add('dock-tabs');
    this.tabBar.element.setAttribute('aria-label', 'ドックの区画');
    this.tabBar.element.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, index) => {
      const item = TAB_ITEMS[index];
      if (!item) return;
      tab.id = `dock-tab-${item[0]}`;
      tab.setAttribute('aria-controls', 'dock-panel-content');
    });
    header.appendChild(this.tabBar.element);

    // 閉じる操作は要求を伝えるだけで、実際に閉じてポーズを解くのは onClose の受け手が行う。
    const closeBtn = new CloseButton(() => this.onClose?.());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    const statusBar = document.createElement('div');
    statusBar.className = 'dock-status-bar';
    statusBar.setAttribute('role', 'status');
    statusBar.setAttribute('aria-live', 'polite');
    this.moneyLabel = document.createElement('span');
    this.moneyLabel.textContent = '利用可能クレジット ---';
    statusBar.appendChild(this.moneyLabel);
    panel.appendChild(statusBar);

    this.bodyEl = document.createElement('main');
    this.bodyEl.id = 'dock-panel-content';
    this.bodyEl.className = 'dock-body';
    this.bodyEl.setAttribute('role', 'tabpanel');
    this.bodyEl.tabIndex = 0;
    panel.appendChild(this.bodyEl);

    this.el.appendChild(panel);
    root.appendChild(this.el);
  }

  // ドックビューを開く
  public open(base: Base, inspectShip: Player | null, freeProcurement: boolean): void {
    if (!this._visible) {
      this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
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
    this.focusEntry();
  }

  public close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.currentBase = null;
    this.currentShip = null;
    const focusTarget = this.previouslyFocused;
    this.previouslyFocused = null;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }

  // aria-modal の宣言どおり、Tab移動を表示中のドック内部だけで循環させる。
  private trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !this._visible) return;
    const focusable = Array.from(this.el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), '
      + '[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getAttribute('aria-disabled') !== 'true' && element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      this.bodyEl.focus({ preventScroll: true });
      return;
    }

    const active = document.activeElement;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (active === first || !this.el.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !this.el.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  private focusEntry(): void {
    const selectedTab = this.tabBar.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (selectedTab ?? this.bodyEl).focus({ preventScroll: true });
  }

  private refresh(): void {
    if (!this.currentBase) return;

    this.moneyLabel.textContent = this.freeProcurement
      ? `${this.currentBase.name} · 調達コストなし`
      : `${this.currentBase.name} · ${this.currentBase.baseState.money.toLocaleString()} Cr 利用可能`;
    this.tabBar.setSelected(this.currentTab);
    this.bodyEl.setAttribute('aria-labelledby', `dock-tab-${this.currentTab}`);

    this.bodyEl.innerHTML = '';
    switch (this.currentTab) {
      case 'ships': this.bodyEl.appendChild(this.buildShipsTab()); break;
      case 'parts': this.bodyEl.appendChild(this.buildPartsTab()); break;
      case 'shop': this.bodyEl.appendChild(this.buildShopTab()); break;
    }
    // 操作した行を再構築してフォーカス要素がDOMから外れた場合も、背面HUDへ落とさない。
    if (this._visible && !this.el.contains(document.activeElement)) this.focusEntry();
  }

  private buildSectionHeader(titleText: string, descriptionText: string, countText: string): HTMLElement {
    const header = document.createElement('header');
    header.className = 'dock-section-head';

    const copy = document.createElement('div');
    copy.className = 'dock-section-copy';
    const title = document.createElement('h2');
    title.className = 'dock-section-title';
    title.textContent = titleText;
    const description = document.createElement('p');
    description.className = 'dock-section-description';
    description.textContent = descriptionText;
    copy.append(title, description);

    const count = document.createElement('span');
    count.className = 'dock-section-count';
    count.textContent = countText;
    header.append(copy, count);
    return header;
  }

  // ─── 格納艦タブ ───────────────────────────────────────────
  private buildShipsTab(): HTMLElement {
    const base = this.currentBase!;
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    const ships = base.baseState.dockedShips;
    frag.appendChild(this.buildSectionHeader(
      '格納艦',
      '発進する艦を選択するか、整備画面で搭載部品を確認します。',
      `${ships.length} / ${C.BASE_MAX_SHIPS} 隻`,
    ));
    if (ships.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '格納艦はありません。ランデブー後に収容するか、新造してください。';
      frag.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'dock-ship-list';
      list.setAttribute('role', 'list');
      ships.forEach((s, i) => list.appendChild(this.buildShipRow(s, i)));
      frag.appendChild(list);
    }
    frag.appendChild(this.buildNewShipHeader(base));
    return frag;
  }

  private buildShipRow(s: DockedShipEntry, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-ship-row';
    row.setAttribute('role', 'listitem');
    const selected = this.currentShip?.id === s.id;
    row.classList.toggle('is-selected', selected);
    const hpRatio = s.maxHp > 0 ? s.hp / s.maxHp : 0;
    row.classList.toggle('is-critical', hpRatio <= 0.3);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'dock-ship-select';
    select.setAttribute('aria-pressed', String(selected));
    select.setAttribute('aria-label', `${s.name || `艦 ${i + 1}`}を選択`);
    select.addEventListener('click', () => {
      this.currentShip = s.player;
      this.refresh();
    });

    const info = document.createElement('div');
    info.className = 'dock-ship-info';
    const name = document.createElement('span');
    name.className = 'dock-ship-name';
    name.textContent = `${s.name || `艦 #${i + 1}`} [ドック ${s.slotIndex + 1}]`;
    const hp = document.createElement('span');
    hp.className = 'dock-ship-hp';
    hp.textContent = `HP ${Math.round(s.hp ?? 0).toLocaleString()} / ${Math.round(s.maxHp ?? 0).toLocaleString()}`;
    info.append(name, hp);
    select.appendChild(info);
    row.appendChild(select);

    const actions = document.createElement('div');
    actions.className = 'dock-ship-actions';
    const launchBtn = new Button('発進', () => this.handleLaunch(i));
    launchBtn.element.classList.add('dock-btn', 'dock-btn-primary');
    const inspectBtn = new Button('部品を見る', () => this.handleInspect(i));
    inspectBtn.element.classList.add('dock-btn', 'dock-btn-quiet');
    actions.append(launchBtn.element, inspectBtn.element);
    row.appendChild(actions);
    return row;
  }

  // 新造(既定パーツ一式の艦を1隻、格納艦へ加える)行。
  private buildNewShipHeader(base: Base): HTMLElement {
    const isFull = base.baseState.dockedShips.length >= C.BASE_MAX_SHIPS;
    const canAfford = !isFull && (this.freeProcurement || base.baseState.money >= NEW_SHIP_COST);
    const row = document.createElement('div');
    row.className = 'dock-parts-header';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.textContent = isFull
      ? `基地のドックが満杯です (最大 ${C.BASE_MAX_SHIPS} 隻)`
      : '既定構成の艦を新造して格納庫へ追加します。';
    row.appendChild(label);
    const btn = new Button(
      isFull
        ? 'ドック満杯'
        : `新造 · ${this.freeProcurement ? 'コストなし' : `${NEW_SHIP_COST.toLocaleString()} Cr`}`,
      () => this.handleBuildShip(),
    );
    btn.element.classList.add('dock-btn', 'dock-btn-primary');
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

    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader(
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
      shipData.parts.forEach((p, i) => list.appendChild(this.buildInstalledPartRow(base, shipData, p, i)));
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
  private buildRepairAllHeader(base: Base, shipData: DockedShipEntry): HTMLElement {
    const totalRepairCost = shipData.parts.reduce((sum, p) => sum + (p.maxHp - p.hp) * REPAIR_COST_PER_HP, 0);
    const enabled = totalRepairCost > 0 && (this.freeProcurement || base.baseState.money >= totalRepairCost);
    const row = document.createElement('div');
    row.className = 'dock-parts-header dock-focus-panel';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.append('整備対象 ');
    const shipName = document.createElement('strong');
    shipName.textContent = shipData.name || '名称未設定の艦';
    label.appendChild(shipName);
    row.appendChild(label);
    const btn = new Button(
      totalRepairCost > 0
        ? `全部品を修理 · ${this.freeProcurement ? 'コストなし' : `${totalRepairCost.toLocaleString()} Cr`}`
        : '全部品は正常',
      () => this.handleRepairAll(shipData.id),
    );
    btn.element.classList.add('dock-btn', 'dock-btn-service');
    btn.element.classList.toggle('dock-btn-complete', totalRepairCost <= 0);
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
    row.setAttribute('role', 'listitem');
    const main = document.createElement('div');
    main.className = 'dock-part-row-main';

    const info = document.createElement('div');
    info.className = 'dock-part-info';
    const name = document.createElement('span');
    name.className = 'dock-part-name';
    name.textContent = p.name;
    const type = document.createElement('span');
    type.className = 'dock-part-type';
    type.textContent = formatPartMeta(p);
    info.append(name, type);
    main.appendChild(info);

    const meter = new Meter();
    meter.element.classList.add('dock-part-hp-meter');
    meter.setRatio(hpPct / 100);
    // 3段階だった健全時/中間の色分けは Meter の「危険=DANGER」1本の規約へ統一する。
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
    const repairBtn = new Button(
      repairCost > 0
        ? `修理 · ${this.freeProcurement ? 'コストなし' : `${repairCost.toLocaleString()} Cr`}`
        : '正常',
      () => this.handleRepairPart(shipData.id, i),
    );
    repairBtn.element.classList.add('dock-btn', 'dock-btn-service');
    repairBtn.element.classList.toggle('dock-btn-complete', repairCost <= 0);
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
    label.textContent = '換装候補';
    row.appendChild(label);
    const select = document.createElement('select');
    select.className = 'dock-part-swap-select';
    for (const c of candidates) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} · 耐久 ${Math.round(c.hp)}/${c.maxHp}`;
      select.appendChild(opt);
    }
    row.appendChild(select);
    const swapBtn = new Button('換装', () => this.handleSwapPart(shipId, partIdx, select.value));
    swapBtn.element.classList.add('dock-btn', 'dock-btn-primary');
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
      const row = document.createElement('div');
      row.className = 'dock-part-row';
      row.setAttribute('role', 'listitem');
      const main = document.createElement('div');
      main.className = 'dock-part-row-main dock-warehouse-row-main';

      const info = document.createElement('div');
      info.className = 'dock-part-info';
      const name = document.createElement('span');
      name.className = 'dock-part-name';
      name.textContent = p.name;
      const type = document.createElement('span');
      type.className = 'dock-part-type';
      type.textContent = formatPartMeta(p);
      info.append(name, type);
      main.appendChild(info);

      const hpText = document.createElement('span');
      hpText.className = 'dock-part-hp-text';
      hpText.textContent = `耐久 ${Math.round(p.hp)}/${p.maxHp}`;
      main.appendChild(hpText);

      const actions = document.createElement('div');
      actions.className = 'dock-part-actions';
      if (p.type === 'rcs_tank') {
        actions.appendChild(this.buildRefuelButton(base, p as RcsTankPart, () => this.handleRefuelInventory(p.id)));
      }
      const price = sellPrice(p);
      const sellBtn = new Button(`売却 · ${price.toLocaleString()} Cr`, () => this.handleSellPart(p.id));
      sellBtn.element.classList.add('dock-btn', 'dock-btn-quiet');
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
    const btn = new Button(
      cost > 0
        ? `燃料補給 · ${this.freeProcurement ? 'コストなし' : `${cost.toLocaleString()} Cr`}`
        : '燃料は満タン',
      onClick,
    );
    btn.element.classList.add('dock-btn', 'dock-btn-service');
    btn.element.classList.toggle('dock-btn-complete', cost <= 0);
    btn.setEnabled(canRefuel);
    return btn.element;
  }

  // ─── ショップタブ ───────────────────────────────────────
  private buildShopTab(): HTMLElement {
    const base = this.currentBase!;
    const money = base.baseState.money;

    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader(
      'ショップ',
      '購入した部品はこの基地の倉庫へ直接搬入されます。',
      `${SHOP_CATALOG.length} 品目`,
    ));

    const list = document.createElement('div');
    list.className = 'dock-shop-list';
    list.setAttribute('role', 'list');
    SHOP_CATALOG.forEach((entry, i) => {
      const canBuy = this.freeProcurement || money >= entry.price;
      const props = Object.entries(entry.props).map(([name, value]) => formatCatalogProperty(name, value)).join(' · ');

      const item = document.createElement('article');
      item.className = 'dock-shop-item';
      item.setAttribute('role', 'listitem');
      const info = document.createElement('div');
      info.className = 'dock-shop-info';
      const name = document.createElement('span');
      name.className = 'dock-shop-name';
      name.textContent = entry.name;
      const type = document.createElement('span');
      type.className = 'dock-shop-type';
      type.textContent = PART_TYPE_LABELS[entry.type];
      const propsEl = document.createElement('span');
      propsEl.className = 'dock-shop-props';
      propsEl.textContent = props || '標準規格';
      const stats = document.createElement('span');
      stats.className = 'dock-shop-stats';
      stats.textContent = `重量 ${entry.weight.toLocaleString()} kg · 耐久 ${entry.maxHp.toLocaleString()}`;
      info.append(name, type, propsEl, stats);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'dock-shop-actions';
      const price = document.createElement('span');
      price.className = 'dock-shop-price';
      price.textContent = this.freeProcurement ? 'コストなし' : `${entry.price.toLocaleString()} Cr`;
      actions.appendChild(price);
      const buyBtn = new Button('購入して倉庫へ', () => this.handleBuy(i));
      buyBtn.element.classList.add('dock-btn', 'dock-btn-primary');
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

  public dispose(): void {
    this.el.remove();
  }
}
