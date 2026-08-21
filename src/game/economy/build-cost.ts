// 搭載要素1つを作るのに要る資源。§6-1 の33種すべてがここに行を持ち、行を持たない種別は
// 型として存在しない(PART_BUILD_MATERIALS が PartType 全体を鍵に取る)。
//
// 表が持つのは質量ではなく**内訳の比**である。質量は `第9版_搭載要素の性能値.md` が33種すべてに
// ついて定めており、実装では Part.weight がその値を持つ。比だけを置けば、性能値が動いたときに
// 建造費が自動で追従する — 質量を2箇所に書けば必ず片方が古くなる。
//
// 内訳は、その要素が実物として何でできているかで決めた。加工済みの部材(電子機器・機械部品・
// 太陽電池パドルなど)が資源として登録されている種別はその部材へ一本化し、素材から直に組む
// 種別(装甲・タンク・構造物)だけを素材へ割り振っている。
import type { AnyPart, PartType } from '../game-entity/parts';
import type { ResourceId } from './resource';
import type { BlueprintResourceAmount } from './producibility';

// 要素の質量に占める、その資源の割合。1種別ぶんの合計は 1 になる。
export interface BuildMaterial {
  readonly resourceId: ResourceId;
  readonly fraction: number;
}

// 推進剤タンクの質量に占める殻の割合。殻の材料は推進剤が決めるので、この割合ぶんの質量は
// PART_BUILD_MATERIALS ではなく生産の tanks の枠が課金する。
export const TANK_SHELL_FRACTION = 0.9;

export const PART_BUILD_MATERIALS: Readonly<Record<PartType, readonly BuildMaterial[]>> = {
  // 主要構造は外皮そのものであり、質量も建造費も形状の側(構造材)が持つ。
  hull: [{ resourceId: 'hull-panel', fraction: 1 }],
  // 装甲板は高強度の金属と、その裏に貼る繊維層。
  armor: [{ resourceId: 'titanium', fraction: 0.7 }, { resourceId: 'carbon-composite', fraction: 0.3 }],

  // 外装要素
  weapon: [
    { resourceId: 'machinery', fraction: 0.7 }, { resourceId: 'titanium', fraction: 0.2 },
    { resourceId: 'electronics', fraction: 0.1 },
  ],
  engine: [
    { resourceId: 'machinery', fraction: 0.55 }, { resourceId: 'titanium', fraction: 0.3 },
    { resourceId: 'electronics', fraction: 0.15 },
  ],
  rcs_thruster: [
    { resourceId: 'machinery', fraction: 0.6 }, { resourceId: 'titanium', fraction: 0.3 },
    { resourceId: 'electronics', fraction: 0.1 },
  ],
  solar_panel: [{ resourceId: 'solar-panel', fraction: 0.8 }, { resourceId: 'structural-metal', fraction: 0.2 }],
  radiator: [
    { resourceId: 'structural-metal', fraction: 0.6 }, { resourceId: 'carbon-composite', fraction: 0.2 },
    { resourceId: 'machinery', fraction: 0.2 },
  ],
  combat_shield: [
    { resourceId: 'titanium', fraction: 0.6 }, { resourceId: 'carbon-composite', fraction: 0.3 },
    { resourceId: 'machinery', fraction: 0.1 },
  ],
  // アブレータは消耗して減る樹脂層であり、その背後の耐熱構造が繊維層である。
  heat_shield: [{ resourceId: 'carbon-composite', fraction: 0.5 }, { resourceId: 'abs-resin', fraction: 0.5 }],
  communication: [
    { resourceId: 'electronics', fraction: 0.5 }, { resourceId: 'structural-metal', fraction: 0.3 },
    { resourceId: 'precision-metal', fraction: 0.2 },
  ],
  robot_arm: [
    { resourceId: 'machinery', fraction: 0.6 }, { resourceId: 'carbon-composite', fraction: 0.2 },
    { resourceId: 'electronics', fraction: 0.2 },
  ],
  docking_port: [
    { resourceId: 'machinery', fraction: 0.5 }, { resourceId: 'structural-metal', fraction: 0.4 },
    { resourceId: 'electronics', fraction: 0.1 },
  ],
  container_coupling: [{ resourceId: 'structural-metal', fraction: 0.7 }, { resourceId: 'machinery', fraction: 0.3 }],

  // 推進剤タンクは殻が質量の TANK_SHELL_FRACTION を占め、残りが弁と配管の金具である。
  // **殻はこの表に載らない** — どの金属で作れるかは積む推進剤が決める(§17-2)ため、
  // 殻の質量は生産の tanks の枠が課金する。したがってこの3行だけは合計が 1 にならない。
  oxidizer_tank: [{ resourceId: 'machinery', fraction: 1 - TANK_SHELL_FRACTION }],
  reductant_tank: [{ resourceId: 'machinery', fraction: 1 - TANK_SHELL_FRACTION }],
  rcs_tank: [{ resourceId: 'machinery', fraction: 1 - TANK_SHELL_FRACTION }],
  // 加圧ガスは推進剤ではなく材料適合性の表を持たないので、殻もこの表が課金する。
  pressurant_tank: [
    { resourceId: 'tank-shell', fraction: TANK_SHELL_FRACTION },
    { resourceId: 'machinery', fraction: 1 - TANK_SHELL_FRACTION },
  ],
  water_tank: [{ resourceId: 'water-tank', fraction: 1 }],
  battery: [
    { resourceId: 'electronics', fraction: 0.4 }, { resourceId: 'precision-metal', fraction: 0.6 },
  ],
  fuel_cell: [{ resourceId: 'fuel-cell', fraction: 1 }],
  rtg: [{ resourceId: 'radioisotope-battery', fraction: 1 }],
  cockpit: [
    { resourceId: 'hull-panel', fraction: 0.5 }, { resourceId: 'structural-metal', fraction: 0.3 },
    { resourceId: 'electronics', fraction: 0.2 },
  ],
  autopilot: [{ resourceId: 'electronics', fraction: 1 }],
  magazine: [{ resourceId: 'machinery', fraction: 0.6 }, { resourceId: 'structural-metal', fraction: 0.4 }],
  ammunition: [{ resourceId: 'ammunition', fraction: 1 }],
  plumbing: [{ resourceId: 'machinery', fraction: 0.5 }, { resourceId: 'titanium', fraction: 0.5 }],
  payload_bay: [{ resourceId: 'hull-panel', fraction: 0.6 }, { resourceId: 'structural-metal', fraction: 0.4 }],
  flywheel: [{ resourceId: 'flywheel-motor', fraction: 0.8 }, { resourceId: 'machinery', fraction: 0.2 }],
  magnetorquer: [{ resourceId: 'magnetorquer-coil', fraction: 0.9 }, { resourceId: 'electronics', fraction: 0.1 }],
  base_module: [
    { resourceId: 'hull-panel', fraction: 0.5 }, { resourceId: 'truss-member', fraction: 0.3 },
    { resourceId: 'machinery', fraction: 0.2 },
  ],
  farm: [{ resourceId: 'farm', fraction: 1 }],
  life_support: [{ resourceId: 'life-support', fraction: 1 }],
  dock: [{ resourceId: 'dock', fraction: 1 }],
};

// 触媒床の質量が推力に正比例する上限 [N]。これを超えると床負荷を上げ、半径方向外向き流れに
// することで床が小さく済むため、推力の 1/2 乗になる(性能値 §6-3)。
const CATALYST_LINEAR_THRUST = 25;
const CATALYST_PER_NEWTON = 1.09e-3; // kg/N
const CATALYST_SQRT_COEFF = 5.45e-3; // kg/√N

// 推力 [N] に対する触媒床の質量 [kg]。境界で2式は連続する(いずれも 27.3 g)。
export function catalystMassFor(thrust: number): number {
  if (!(thrust > 0)) return 0;
  return thrust <= CATALYST_LINEAR_THRUST
    ? CATALYST_PER_NEWTON * thrust
    : CATALYST_SQRT_COEFF * Math.sqrt(thrust);
}

// 触媒床を要する推進剤。単推進剤のヒドラジンだけが分解に触媒を要し、二液推進剤は自己着火性で
// あって触媒を要さない(性能値 §6-4)。
export function needsCatalystBed(propellant: string): boolean {
  return propellant === 'hydrazine';
}

// 要素1つを作るのに要る資源。触媒床は質量の内訳ではなく、推力から別に決まる追加の要求である。
export function partBuildCost(part: AnyPart): readonly BlueprintResourceAmount[] {
  const cost: BlueprintResourceAmount[] = [];
  for (const material of PART_BUILD_MATERIALS[part.type]) {
    const mass = part.weight * material.fraction;
    if (mass > 0) cost.push({ resourceId: material.resourceId, mass });
  }
  if ((part.type === 'engine' || part.type === 'rcs_thruster') && part.catalystMass > 0) {
    cost.push({ resourceId: 'catalyst-bed', mass: part.catalystMass });
  }
  return cost;
}
