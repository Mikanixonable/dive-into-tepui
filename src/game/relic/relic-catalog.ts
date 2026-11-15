// 遺物の定義(SPEC GAME.md 3.2)。値は実行中に変わらないので、発見の状態は持たない。
// 発見の記録は stage-utils/relic-hunt.ts が持ち、セーブ枠へは launcher が書く。
import type { OrbitSlotOrbit } from '../navigation/orbit-slot';

const KM = 1000;
const DEG = Math.PI / 180;

// 遺物1件の定義。
export interface RelicDefinition {
  // 遺物の識別子。セーブ枠の発見の記録は、この id で持つ。
  readonly id: string;
  // 発見したときに軌道標識として台帳へ加わる名前。
  readonly name: string;
  // 発見の告知に添える由来。
  readonly origin: string;
  // 反射の検出を始める距離 [m]。
  readonly detectRange: number;
  // 発見になる距離 [m]。
  readonly discoverRange: number;
  // 地球の半径 earthRadius [m] を受けて、参照軌道の記述を組む。
  readonly orbit: (earthRadius: number) => OrbitSlotOrbit;
}

// LAGEOS-1: 地球を回る近地点高度 5,860 km・遠地点高度 5,960 km・傾斜角 109.8° の軌道。
// 位相は simTime=0 で近地点に置く。
const LAGEOS_1: RelicDefinition = {
  id: 'lageos-1',
  name: 'LAGEOS-1',
  origin: '西暦1976年に打ち上げられた測地衛星。840万年のあいだ軌道に留まるよう作られた。',
  detectRange: 3000 * KM,
  discoverRange: 100 * KM,
  orbit: (earthRadius) => {
    const rp = earthRadius + 5860 * KM;
    const ra = earthRadius + 5960 * KM;
    return {
      kind: 'elements', bodyId: 'earth', epoch: 0,
      a: (rp + ra) / 2, e: (ra - rp) / (ra + rp), i: 109.8 * DEG,
      raan: 0, argPeriapsis: 0, meanAnomaly0: 0,
    };
  },
};

// 遺物の全件。
export const RELICS: readonly RelicDefinition[] = [LAGEOS_1];

// id の遺物。無ければ null。
export function relicById(id: string): RelicDefinition | null {
  return RELICS.find((relic) => relic.id === id) ?? null;
}
