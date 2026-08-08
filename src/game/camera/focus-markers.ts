// マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点等)ラベルの算出と
// HUD マーカーへの反映。
import { Vec3, v3 } from '../../physics/vec3';
import { AttractorId, OrbitingId } from '../../physics/attractor';
import { bodyDef, SOLAR_SYSTEM } from '../../physics/solar-system';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import { CELESTIAL_BODIES } from '../celestial/celestial-registry';

export interface FocusLabel {
  id: string;
  name: string;
  pos: Vec3;
  kind: 'body';
}

const ATTRACTOR_IDS = Object.keys(SOLAR_SYSTEM) as AttractorId[];
// 公転している天体(惑星 + 衛星)= ラグランジュ点を持てる天体。
const ORBITING_IDS = ATTRACTOR_IDS.filter((id) => bodyDef(id).kind !== 'star') as OrbitingId[];

// ラベル id とその表示名。天体本体 1 つにつき、公転しているならその L1〜L5 も足す
// (表示名は「中心天体名-自分の名 Ln」)。
const LABEL_NAMES: Record<string, string> = {};
for (const id of ATTRACTOR_IDS) LABEL_NAMES[id] = CELESTIAL_BODIES[id].name;
for (const id of ORBITING_IDS) {
  const def = bodyDef(id);
  const primary: AttractorId = def.kind === 'planet' ? 'sun' : def.planet;
  const prefix = `${CELESTIAL_BODIES[primary].name}-${CELESTIAL_BODIES[id].name}`;
  for (const n of [1, 2, 3, 4, 5]) LABEL_NAMES[`${id}-l${n}`] = `${prefix} L${n}`;
}

export class FocusMarkers {
  readonly labels: FocusLabel[] = Object.entries(LABEL_NAMES).map(([id, name]) => ({
    id,
    name,
    pos: v3(0, 0, 0),
    kind: 'body',
  }));

  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {}

  // 表示時刻 t の各ラベル座標を求め直す。
  update(t: number): void {
    const ephemeris = this.ephemeris;

    const positions: Record<string, Vec3> = {};
    for (const id of ATTRACTOR_IDS) positions[id] = ephemeris.positionOf(id, t);
    for (const id of ORBITING_IDS) {
      const l = ephemeris.lagrangeAt(id, t);
      for (const n of [1, 2, 3, 4, 5] as const) positions[`${id}-l${n}`] = l[`L${n}`];
    }

    for (const lbl of this.labels) lbl.pos = positions[lbl.id]!;
  }

  // update が求めた座標へラベルのマーカーを置く。
  syncLabels(project: ProjectFn): void {
    for (const lbl of this.labels) {
      this.markerManager.setPosition(lbl.id, 'mk-poi', '●', lbl.pos, project, lbl.name);
    }
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    for (const lbl of this.labels) this.markerManager.hide(lbl.id);
  }

  // id に対応するラベルを返す。存在しなければ undefined。
  findLabel(id: string): FocusLabel | undefined {
    return this.labels.find((l) => l.id === id);
  }
}
