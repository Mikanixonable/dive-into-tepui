import { Button } from '../widgets';
import type { AnyPart, Part, PartType, RcsTankPart } from '../../game-entity/parts';
import * as C from '../../const';

// 基地パネルの3タブ(格納艦艇/部品/ショップ)が共有する処理を持つ。
// ショップカタログ・売却額・補給額といった価格計算と、dock-btn の見た目や
// セクション見出しなどタブ間で繰り返す DOM 組み立てを提供する。

// ショップで購入可能な部品カタログ
interface PartCatalogEntry {
  readonly type: PartType;
  readonly name: string;
  readonly price: number;
  readonly weight: number;
  readonly maxHp: number;
  // 部品ごとの追加プロパティ (thruster の thrust など)
  readonly props: Record<string, number | string>;
}

// SHOP_CATALOG の各値は、新造時の既定艦(重量 100 / 推力 PLAYER_MASS×最大スロットル /
// 冷却 25 / 発電 50 / 発射レート 1÷FIRE_INTERVAL)と単位・桁を合わせる。ずれると、
// 換装した瞬間に推力や耐久が別物になる。
const DEFAULT_TORQUE = C.MAX_ANG_ACCEL * Math.max(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL);
const DEFAULT_THRUST = C.PLAYER_MASS * C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!;
export const SHOP_CATALOG: readonly PartCatalogEntry[] = [
  { type: 'hull', name: 'Standard Hull', price: 5000, weight: 80, maxHp: 300, props: {} },
  { type: 'hull', name: 'Reinforced Hull', price: 12000, weight: 180, maxHp: 600, props: {} },
  { type: 'cockpit', name: 'Basic Cockpit', price: 3000, weight: 100, maxHp: 100, props: {} },
  { type: 'armor', name: 'Light Armor', price: 2000, weight: 100, maxHp: 100, props: { damageReduction: 0.2 } },
  { type: 'armor', name: 'Heavy Armor', price: 8000, weight: 260, maxHp: 250, props: { damageReduction: 0.4 } },
  { type: 'thruster', name: 'Standard RCS', price: 4000, weight: 100, maxHp: 80, props: { torque: DEFAULT_TORQUE, thrust: DEFAULT_THRUST, fuelConsumptionRate: 1 } },
  { type: 'thruster', name: 'High-Thrust RCS', price: 10000, weight: 220, maxHp: 80, props: { torque: DEFAULT_TORQUE * 2, thrust: DEFAULT_THRUST * 2.5, fuelConsumptionRate: 2.5 } },
  { type: 'rcs_tank', name: 'Small RCS Tank', price: 1500, weight: 60, maxHp: 50, props: { maxFuel: 600, fuel: 600 } },
  { type: 'rcs_tank', name: 'Large RCS Tank', price: 4000, weight: 210, maxHp: 110, props: { maxFuel: 2200, fuel: 2200 } },
  { type: 'radiator', name: 'Heat Radiator', price: 3000, weight: 100, maxHp: 50, props: { coolingRate: 42 } },
  { type: 'radiator', name: 'Advanced Radiator', price: 7000, weight: 160, maxHp: 60, props: { coolingRate: 92 } },
  { type: 'solar_panel', name: 'Solar Array', price: 2500, weight: 100, maxHp: 30, props: { powerGeneration: 50 } },
  { type: 'solar_panel', name: 'High-Efficiency Solar', price: 6000, weight: 130, maxHp: 30, props: { powerGeneration: 120 } },
  { type: 'weapon', name: 'Gatling Gun', price: 5000, weight: 100, maxHp: 80, props: { weaponType: 'gatling', fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_BULLET_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED } },
  { type: 'weapon', name: 'Heavy Cannon', price: 15000, weight: 220, maxHp: 120, props: { weaponType: 'cannon', fireRate: 4, damage: C.ENEMY_BULLET_DAMAGE * 5, muzzleVelocity: C.MUZZLE_SPEED * 1.5 } },
];

// 修理コスト: 1HPあたりのクレジット
export const REPAIR_COST_PER_HP = 10;
// 倉庫の部品を売却したときの掛け率。無限増殖を防ぐため購入価格を下回らせる。
const PART_SELL_RATE = 0.5;
// カタログに一致しない部品(艦に最初から積まれていたものなど)の売却基準額。maxHpに比例させる。
const PART_FALLBACK_VALUE_PER_MAXHP = 20;
// RCSタンクへの燃料補給コスト: 1kgあたりのクレジット
const RCS_REFUEL_PRICE_PER_KG = 2;
// 新造艦艇(既定パーツ一式)の価格。SHOP_CATALOG の最安構成の合計(≈31,500 Cr)に組立分を上乗せした額。
export const NEW_VESSEL_COST = 35000;

// 部品の売却基準額を見積もる。ショップカタログに type/name が一致する項目があればその価格を、
// なければ maxHp から概算した価格を使う(艦に最初から積まれていた部品など由来不明なもの向け)。
function estimatePartValue(part: AnyPart): number {
  const catalogEntry = SHOP_CATALOG.find((e) => e.type === part.type && e.name === part.name);
  return catalogEntry ? catalogEntry.price : part.maxHp * PART_FALLBACK_VALUE_PER_MAXHP;
}

// 部品を売却したときにプレイヤーが受け取る額を返す。
export function sellPrice(part: AnyPart): number {
  return Math.round(estimatePartValue(part) * PART_SELL_RATE);
}

// RCS タンクを満タンまで補給するのに必要な額を返す。満タンなら0。
export function refuelCost(tank: RcsTankPart): number {
  return Math.max(0, Math.round((tank.maxFuel - tank.fuel) * RCS_REFUEL_PRICE_PER_KG));
}

// 金額を表示用の文字列にする。freeProcurement のときは金額を出さず定型の案内文を返す。
export function costLabel(freeProcurement: boolean, amount: number): string {
  return freeProcurement ? 'コストなし' : `${amount.toLocaleString()} Cr`;
}

export const PART_TYPE_LABELS: Readonly<Record<PartType, string>> = {
  hull: '船体',
  cockpit: '操縦区画',
  armor: '装甲',
  thruster: 'RCS 推進器',
  rcs_tank: 'RCS タンク',
  radiator: '放熱器',
  solar_panel: '太陽電池',
  weapon: '武装',
};

// Part が RcsTankPart かどうかを判定する型ガード。
export function isRcsTank(part: Part): part is RcsTankPart {
  return part.type === 'rcs_tank';
}

// 部品の種別ラベルを返す。rcs_tank は燃料残量も添える。
export function formatPartMeta(part: Part): string {
  if (!isRcsTank(part)) return PART_TYPE_LABELS[part.type];
  return `${PART_TYPE_LABELS[part.type]} · 燃料 ${Math.round(part.fuel).toLocaleString()} / ${Math.round(part.maxFuel).toLocaleString()} kg`;
}

// カタログのプロパティ1件を、単位付きの表示用文字列にする。
export function formatCatalogProperty(name: string, value: number | string): string {
  switch (name) {
    // 物理量系は単位付きの数値表記にする。
    case 'damageReduction': return `被害軽減 ${typeof value === 'number' ? Math.round(value * 100) : value} %`;
    case 'torque': return `トルク ${Number(value).toLocaleString()} N·m`;
    case 'thrust': return `推力 ${Number(value).toLocaleString()} N`;
    case 'fuelConsumptionRate': return `燃料消費 ${value} kg/s`;
    case 'maxFuel': return `燃料容量 ${Number(value).toLocaleString()} kg`;
    case 'fuel': return `初期燃料 ${Number(value).toLocaleString()} kg`;
    case 'coolingRate': return `放熱面積 ${value} m²`;
    case 'powerGeneration': return `発電 ${Number(value).toLocaleString()} W`;
    // 武装系は表示名を日本語へ言い換える。
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

// タイトル・説明・件数からなる、タブ共通のセクション見出しを組み立てる。
export function buildSectionHeader(titleText: string, descriptionText: string, countText: string): HTMLElement {
  const header = document.createElement('header');
  header.className = 'dock-section-head';

  // タイトルと説明文をまとめた見出し本文。
  const copy = document.createElement('div');
  copy.className = 'dock-section-copy';
  const title = document.createElement('h2');
  title.className = 'dock-section-title';
  title.textContent = titleText;
  const description = document.createElement('p');
  description.className = 'dock-section-description';
  description.textContent = descriptionText;
  copy.append(title, description);

  // 件数バッジ。
  const count = document.createElement('span');
  count.className = 'dock-section-count';
  count.textContent = countText;
  header.append(copy, count);
  return header;
}

export type DockBtnVariant = 'primary' | 'service' | 'quiet';

// dock-btn の外見クラスを付与する。complete を渡すと、料金が0になった完了状態の見た目も切り替える。
export function styleDockBtn(el: HTMLElement, variant: DockBtnVariant, complete?: boolean): void {
  el.classList.add('dock-btn', `dock-btn-${variant}`);
  if (complete !== undefined) el.classList.toggle('dock-btn-complete', complete);
}

// 支払って実行する系のボタンを組み立てる。cost が0以下なら完了表示にし、資金不足なら無効化する。
export function buildFeeButton(
  freeProcurement: boolean, money: number, cost: number,
  actionLabel: string, doneLabel: string, onClick: () => void,
): HTMLElement {
  const enabled = cost > 0 && (freeProcurement || money >= cost);
  const btn = new Button(cost > 0 ? `${actionLabel} · ${costLabel(freeProcurement, cost)}` : doneLabel, onClick);
  styleDockBtn(btn.element, 'service', cost <= 0);
  btn.setEnabled(enabled);
  return btn.element;
}
