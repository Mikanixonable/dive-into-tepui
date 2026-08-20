// 機体が何をできるか(操作・通信・自動操縦・格納・推進)を、積んでいる搭載要素から導く。
import type { Vec3 } from '../../physics/vec3';
import type { CommunicationPart, Part, PartType } from '../game-entity/parts';

// 能力判定が機体に求める形。Vessel が構造的にこれを満たす。
export interface CapabilityVessel {
  readonly parts: readonly Part[];
  readonly state: { readonly r: Vec3 };
}

// 通信圏の内外の問い合わせ。ALWAYS_IN_COVERAGE は常に圏内と答える既定の実装。
export interface CoverageQuery {
  inCoverage(pos: Vec3, moduleRange: number): boolean;
}

export const ALWAYS_IN_COVERAGE: CoverageQuery = { inCoverage: () => true };

// 健全な(HP が残っている)搭載要素を型で探す。全損した要素は能力を与えない。
function hasWorkingPart(vessel: CapabilityVessel, type: PartType): boolean {
  return vessel.parts.some((p) => p.type === type && p.hp > 0);
}

// 人が乗って操作できる。
export function hasCockpit(vessel: CapabilityVessel): boolean {
  return hasWorkingPart(vessel, 'cockpit');
}

// 通信モジュールを持つ。
export function hasCommunication(vessel: CapabilityVessel): boolean {
  return hasWorkingPart(vessel, 'communication');
}

// 自動操縦装置を持つ。
function hasAutopilotUnit(vessel: CapabilityVessel): boolean {
  return hasWorkingPart(vessel, 'autopilot');
}

// 有人コックピットまたは自動操縦装置を持つ構成は単独で運用できる宇宙船であり、
// どちらも持たない構成は貨物として扱う。通信圏による現在の操作可否とは分けた分類である。
export function hasCorePart(vessel: CapabilityVessel): boolean {
  return hasCockpit(vessel) || hasAutopilotUnit(vessel);
}

export function isCargo(vessel: CapabilityVessel): boolean {
  return !hasCorePart(vessel);
}

// 格納・倉庫・生産ができる。
export function hasBaseModule(vessel: CapabilityVessel): boolean {
  return hasWorkingPart(vessel, 'base_module');
}

// 主機を持つ。
export function hasEngine(vessel: CapabilityVessel): boolean {
  return hasWorkingPart(vessel, 'engine');
}

// 健全な通信モジュールのうち最も遠くまで届く到達距離 [m]。1つも無ければ 0。
export function communicationRange(vessel: CapabilityVessel): number {
  let range = 0;
  for (const p of vessel.parts) {
    if (p.type !== 'communication' || p.hp <= 0) continue;
    range = Math.max(range, (p as CommunicationPart).range);
  }
  return range;
}

// 通信網の起点になる機体か。通信基地は基地モジュールと大型の通信設備の組であり(§13-3)、
// それ自身を示す搭載要素は無い。
export function isCommStation(vessel: CapabilityVessel): boolean {
  return hasBaseModule(vessel) && communicationRange(vessel) > 0;
}

// 無人での計画実行は、装置と通信圏の両方を要する。同じ機体でも場所によって可否が変わる。
export function canAutopilot(vessel: CapabilityVessel, coverage: CoverageQuery): boolean {
  if (!hasAutopilotUnit(vessel) || !hasCommunication(vessel)) return false;
  return coverage.inCoverage(vessel.state.r, communicationRange(vessel));
}

// 操作対象に選べる機体か。人が乗っていれば圏外でも判断できる。
export function isOperable(vessel: CapabilityVessel, coverage: CoverageQuery): boolean {
  return hasCockpit(vessel) || canAutopilot(vessel, coverage);
}
