// 勢力と中心天体ごとに、個体の軌道帯とラグランジュ点の占有域を導出する。
import { orbitingAttractorOf } from '../../physics/attractor';
import { orbitalElementsOf } from '../../physics/elements';
import type { CelestialBody } from '../../physics/celestial-body';
import { lenSq, sub, type Vec3 } from '../../math/vec3';
import { isEnemy } from '../dynamic/entity/enemy';
import { isModularShip } from '../ship/modular-ship';
import type { DynamicEntity } from '../dynamic/entity/dynamic-entity';

export type Faction = 'enemy' | 'friendly';

// 個体の勢力。敵は敵勢力、自艦・基地・補給艇(= ModularShip)は味方勢力、それ以外(弾薬など)は
// どちらにも属さない。
export function factionOf(entity: DynamicEntity): Faction | null {
  if (isEnemy(entity)) return 'enemy';
  if (isModularShip(entity)) return 'friendly';
  return null;
}

// 天体まわりの占有域1枚。中心天体を周回する構成員の近点距離の最小〜遠点距離の最大の帯。
export interface FactionOrbitZone {
  readonly bodyId: string;
  readonly faction: Faction;
  readonly innerRadius: number;
  readonly outerRadius: number;
}

// 閉軌道にある生存個体の近点距離と遠点距離から、勢力×中心天体の占有帯を返す。
export function factionOrbitZones(
  entities: readonly DynamicEntity[],
  attractors: readonly CelestialBody[],
  t: number,
  include: (entity: DynamicEntity) => Faction | null,
): FactionOrbitZone[] {
  const zones = new Map<string, { faction: Faction; innerRadius: number; outerRadius: number }>();
  for (const entity of entities) {
    if (!entity.motion.alive) continue;
    const faction = include(entity);
    if (faction === null) continue;
    const state = entity.motion.stateAt(t);
    if (state === null) continue;
    const center = orbitingAttractorOf(state, attractors, t);
    if (center === null) continue;
    const elements = orbitalElementsOf(state, center, t);
    if (elements === null) continue;
    const inner = elements.p / (1 + elements.e);
    const outer = elements.p / (1 - elements.e);
    // 円軌道では近点=遠点になる — 幅 0 の帯も域として立て、最小幅は描画側が与える。
    if (!(inner > 0) || outer < inner) continue;
    const key = `${center.id}:${faction}`;
    const zone = zones.get(key);
    if (zone === undefined) zones.set(key, { faction, innerRadius: inner, outerRadius: outer });
    else {
      zones.set(key, {
        faction,
        innerRadius: Math.min(zone.innerRadius, inner),
        outerRadius: Math.max(zone.outerRadius, outer),
      });
    }
  }
  return [...zones.entries()].map(([key, zone]) => ({
    bodyId: key.slice(0, key.indexOf(':')),
    faction: zone.faction,
    innerRadius: zone.innerRadius,
    outerRadius: zone.outerRadius,
  }));
}

// ラグランジュ点の占有判定の半径。系の主星・副星間距離に対する比率(SPEC「勢力の占有域」)。
export const LAGRANGE_ZONE_RADIUS_RATIO = 0.08;

// ラグランジュ点1点の占有。両勢力が範囲内にいれば2つ返る。
export interface FactionLagrangeZone {
  readonly pointId: string;
  readonly faction: Faction;
  readonly position: Vec3;
  readonly radius: number; // 判定に使った半径 [m]
}

// 点の位置と判定半径を受け取り、構成員のいる勢力ぶんだけ占有ゾーンを返す。
export function factionLagrangeZones(
  members: readonly { faction: Faction; position: Vec3 }[],
  points: readonly { id: string; position: Vec3; radius: number }[],
): FactionLagrangeZone[] {
  const zones: FactionLagrangeZone[] = [];
  // 各点の占有を勢力ごとにまとめる。
  for (const point of points) {
    const occupied = new Set<Faction>();
    for (const member of members) {
      if (lenSq(sub(member.position, point.position)) <= point.radius * point.radius) {
        occupied.add(member.faction);
      }
    }
    for (const faction of occupied) {
      zones.push({ pointId: point.id, faction, position: point.position, radius: point.radius });
    }
  }
  return zones;
}
