// 基地の在庫を引いて艦・倉庫の状態を書き換える実行部分(修理・補給・換装・生産)。
// 「基地の資源を引いて艦を直す」は基地×艦の関係であり艦単体の責務ではないので、Vessel の
// メソッドにはせずここへ独立関数として置く。各関数は「足りるか判定 → 資源を引く → 書き込む」を
// 1関数にまとめ、資源だけ引いて書き込みに失敗する・書き込んだのに資源を引き損なうといった
// 部分適用を作らない。
import type { AnyPart, Part, PropellantTankPart } from '../game-entity/parts';
import { propellantTankCapacity } from '../economy/propellant-compatibility';
import { affordableProductionRequest } from '../hud/inventory-labels';
import type { DockedVesselEntry, Vessel } from './vessel';
import {
  consumeProductionResources, partProductionBlueprintOf, refuelBlueprintOf, repairAllBlueprintOf, repairBlueprintOf,
} from './production';
import { buildPartFrom } from './default-blueprints';

// 格納艦の hp/maxHp 集計スナップショットを parts の実体へ揃える。
function syncDockedSnapshot(shipData: DockedVesselEntry): void {
  shipData.vessel.refreshFromParts();
  shipData.hp = shipData.vessel.hp;
  shipData.maxHp = shipData.vessel.maxHp;
}

// 損傷した搭載要素1件を修理する。既に満耐久なら何もせず false。
export function repairPart(base: Vessel, shipData: DockedVesselEntry, part: Part): boolean {
  if (part.hp >= part.maxHp) return false;
  const request = repairBlueprintOf(part as AnyPart);
  if (!affordableProductionRequest(base, request)) return false;
  if (!consumeProductionResources(request, base.baseState!.resources)) return false;
  part.hp = part.maxHp;
  syncDockedSnapshot(shipData);
  return true;
}

// 艦の全搭載要素をまとめて修理する。損傷がなければ何もせず false。
export function repairAllParts(base: Vessel, shipData: DockedVesselEntry): boolean {
  const damaged = (shipData.parts as AnyPart[]).filter((p) => p.hp < p.maxHp);
  if (damaged.length === 0) return false;
  const request = repairAllBlueprintOf(damaged);
  if (!affordableProductionRequest(base, request)) return false;
  if (!consumeProductionResources(request, base.baseState!.resources)) return false;
  damaged.forEach((p) => { p.hp = p.maxHp; });
  syncDockedSnapshot(shipData);
  return true;
}

// 推進剤タンクを満タンまで補給する。既に満タンなら何もせず false。
export function refuelPropellantTank(base: Vessel, tank: PropellantTankPart): boolean {
  const capacity = propellantTankCapacity(tank.propellant, tank.volume);
  const missing = Math.max(0, capacity - tank.fuel);
  if (missing <= 0) return false;
  const request = refuelBlueprintOf(tank.propellant, missing);
  if (!affordableProductionRequest(base, request)) return false;
  if (!consumeProductionResources(request, base.baseState!.resources)) return false;
  tank.fuel = capacity;
  return true;
}

// 搭載部品を倉庫在庫(同じ type)と入れ替える。外した部品は倉庫へ戻す。型が合わなければ false。
export function swapInstalledPart(
  base: Vessel, shipData: DockedVesselEntry, partIdx: number, invId: string,
): boolean {
  const installed = shipData.parts[partIdx];
  if (!installed) return false;
  const inventory = base.baseState!.inventory;
  const invIdx = inventory.findIndex((p) => p.id === invId);
  const incoming = inventory[invIdx];
  if (!incoming || incoming.type !== installed.type) return false;
  // 資源は動かないので producibility は問わず、双方の配列を差し替えるだけでよい。
  shipData.parts.splice(partIdx, 1, incoming);
  inventory.splice(invIdx, 1, installed as AnyPart);
  syncDockedSnapshot(shipData);
  return true;
}

// 搭載要素を1つ生産し、基地の倉庫へ加える。
export function producePart(base: Vessel, sample: AnyPart): boolean {
  const request = partProductionBlueprintOf(sample);
  if (!affordableProductionRequest(base, request)) return false;
  if (!consumeProductionResources(request, base.baseState!.resources)) return false;
  base.baseState!.inventory.push(buildPartFrom(sample));
  return true;
}
