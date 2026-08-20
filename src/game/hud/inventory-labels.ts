// 基地が抱える在庫 — 搭載要素と資源 — の日本語表示名。数値の整形もここに揃え、
// 同じ部品・同じ資源がどの画面でも同じ文字列で読めるようにする。
import type { Part, PartType, RcsTankPart } from '../game-entity/parts';
import { RESOURCES, type ResourceId } from '../economy/resource';

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

// 部品1件の副題。RCS タンクだけは残量が種別と同じくらい効くので併記する。
export function formatPartMeta(part: Part): string {
  if (part.type !== 'rcs_tank') return PART_TYPE_LABELS[part.type];
  const tank = part as RcsTankPart;
  return `${PART_TYPE_LABELS[part.type]} · 燃料 ${Math.round(tank.fuel).toLocaleString()} / ${Math.round(tank.maxFuel).toLocaleString()} kg`;
}

// 資源1件の表示名と量。1kg 未満は桁を増やして 0.0 kg に潰れないようにする。
export function formatResourceAmount(id: string, mass: number): string {
  const def = RESOURCES[id as ResourceId];
  const name = def === undefined ? id : def.name;
  return `${name} ${mass < 1 ? mass.toFixed(3) : mass.toFixed(1)} kg`;
}
