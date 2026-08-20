// 基地が抱える在庫 — 搭載要素と資源 — の日本語表示名。数値の整形もここに揃え、
// 同じ部品・同じ資源がどの画面でも同じ文字列で読めるようにする。建造・修理・補給・生産の
// 費用表示は productionCostSummary を通し、可否判定を賄い額の内訳計算と別基準にしない。
import type { Part, PartType } from '../game-entity/parts';
import { isPropellantTankPart } from '../game-entity/parts';
import { RESOURCES, type ResourceId } from '../economy/resource';
import { propellantTankCapacity } from '../economy/propellant-compatibility';
import type { ProducibilityBlueprint } from '../economy/producibility';
import { affordableProductionRequest, productionResourceDemand } from '../vessel/production';
import type { Vessel } from '../vessel/vessel';

export const PART_TYPE_LABELS: Readonly<Record<PartType, string>> = {
  hull: '船体',
  cockpit: '操縦区画',
  armor: '装甲',
  weapon: '武装',
  engine: '主機',
  rcs_thruster: 'RCS スラスタ',
  solar_panel: '太陽電池',
  radiator: '放熱器',
  combat_shield: '戦闘用シールド',
  heat_shield: '熱シールド',
  communication: '通信モジュール',
  robot_arm: 'ロボットアーム',
  docking_port: 'ドッキングポート',
  container_coupling: 'コンテナ接合部',
  oxidizer_tank: '酸化剤タンク',
  reductant_tank: '還元剤タンク',
  pressurant_tank: '加圧ガスタンク',
  rcs_tank: 'RCS タンク',
  water_tank: '水タンク',
  battery: 'バッテリー',
  fuel_cell: '燃料電池',
  rtg: '原子力電池',
  autopilot: '自動操縦装置',
  magazine: '弾薬庫',
  ammunition: '弾薬',
  plumbing: '配管',
  payload_bay: 'ペイロード倉庫',
  flywheel: 'フライホイール',
  magnetorquer: '磁気トルカ',
  base_module: '基地モジュール',
  farm: '農場',
  life_support: '生命維持装置',
  dock: 'ドック',
};

// 部品1件の副題。推進剤タンクだけは残量が種別と同じくらい効くので併記する。
export function formatPartMeta(part: Part): string {
  if (!isPropellantTankPart(part)) return PART_TYPE_LABELS[part.type];
  const capacity = propellantTankCapacity(part.propellant, part.volume);
  return `${PART_TYPE_LABELS[part.type]} · 燃料 ${Math.round(part.fuel).toLocaleString()} / ${Math.round(capacity).toLocaleString()} kg`;
}

// 資源1件の表示名と量。1kg 未満は桁を増やして 0.0 kg に潰れないようにする。
export function formatResourceAmount(id: string, mass: number): string {
  const def = RESOURCES[id as ResourceId];
  const name = def === undefined ? id : def.name;
  return `${name} ${mass < 1 ? mass.toFixed(3) : mass.toFixed(1)} kg`;
}

export interface ProductionCostSummary {
  readonly costText: string;
  readonly affordable: boolean;
}

// 要求を賄えるかと、資源だけを畳んだ費用文言をまとめて返す。両者は同じ producibility 判定・
// 同じ資源帳簿を読むので、片方だけ古い基準で判定することがない。
export function productionCostSummary(base: Vessel, request: ProducibilityBlueprint): ProductionCostSummary {
  const demand = productionResourceDemand(request, base.baseState!.resources);
  const costText = [...demand].map(([id, mass]) => formatResourceAmount(id, mass)).join('・') || '資源なし';
  return { costText, affordable: affordableProductionRequest(base, request) };
}
