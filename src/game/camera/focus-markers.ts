// マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点等)ラベルの算出と
// HUD マーカーへの反映。
import { Vec3, v3 } from '../../physics/vec3';
import { Attractor, AttractorId, OrbitingId } from '../../physics/attractor';
import { bodyDef, primaryOf } from '../../physics/solar-system';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import { celestialBodyName } from '../hud/frame-labels';
import { isOccluded } from '../../physics/occlusion';
import { FOCUS_LABEL_PRIORITY_PX } from '../const';

export interface FocusLabel {
  id: string;
  name: string;
  pos: Vec3;
  kind: 'body';
  isLagrange: boolean;
}

export class FocusMarkers {
  // 天体本体1つにつき1ラベル、ラグランジュ点ラベルを出す天体(lagrangeSourceIds — 公転して
  // いて、かつ軌道設計の目標になる系)にはさらに L1〜L5 の5ラベルが並ぶ(表示名は
  // 「中心天体名-自分の名 Ln」)。
  private readonly registryIds: readonly AttractorId[];
  private readonly lagrangeSourceIds: readonly OrbitingId[];
  readonly labels: FocusLabel[];

  private attractors: readonly Attractor[] = [];

  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {
    const registry = ephemeris.registry;
    this.registryIds = Object.keys(registry);
    this.lagrangeSourceIds = this.registryIds.filter((id) => {
      const def = bodyDef(registry, id);
      return def.kind !== 'star' && def.lagrangeLabels === true;
    });

    this.labels = this.registryIds.map((id) => ({
      id, name: celestialBodyName(id), pos: v3(0, 0, 0), kind: 'body' as const, isLagrange: false,
    }));
    for (const id of this.lagrangeSourceIds) {
      const primary = primaryOf(registry, id);
      const prefix = `${primary === null ? celestialBodyName(id) : celestialBodyName(primary)}-${celestialBodyName(id)}`;
      for (const n of [1, 2, 3, 4, 5]) {
        this.labels.push({ id: `${id}-l${n}`, name: `${prefix} L${n}`, pos: v3(0, 0, 0), kind: 'body', isLagrange: true });
      }
    }
  }

  // 表示時刻 t の各ラベル座標を求め直す。
  update(t: number): void {
    const ephemeris = this.ephemeris;

    const positions: Record<string, Vec3> = {};
    for (const id of this.registryIds) positions[id] = ephemeris.positionOf(id, t);
    for (const id of this.lagrangeSourceIds) {
      const l = ephemeris.lagrangeAt(id, t);
      for (const n of [1, 2, 3, 4, 5] as const) positions[`${id}-l${n}`] = l[`L${n}`];
    }

    for (const lbl of this.labels) lbl.pos = positions[lbl.id]!;
    this.attractors = ephemeris.attractorsAt(t);
  }

  // update が求めた座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 天体ラベルと画面上で近接するラグランジュ点ラベルは天体側を優先して隠す。
  syncLabels(project: ProjectFn, cameraPos: Vec3): void {
    const shownBodyScreenPos: { x: number; y: number }[] = [];
    for (const lbl of this.labels) {
      if (lbl.isLagrange) continue;
      if (isOccluded(cameraPos, lbl.pos, this.attractors)) continue;
      const p = project(lbl.pos);
      if (p.front) shownBodyScreenPos.push(p);
    }

    for (const lbl of this.labels) {
      if (isOccluded(cameraPos, lbl.pos, this.attractors)) {
        this.markerManager.hide(lbl.id);
        continue;
      }
      const p = project(lbl.pos);
      if (lbl.isLagrange && p.front && shownBodyScreenPos.some(
        (b) => Math.hypot(b.x - p.x, b.y - p.y) < FOCUS_LABEL_PRIORITY_PX,
      )) {
        this.markerManager.hide(lbl.id);
        continue;
      }
      this.markerManager.setPosition(lbl.id, 'mk-poi', '●', lbl.pos, project, lbl.name);
    }
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    for (const lbl of this.labels) this.markerManager.hide(lbl.id);
  }
}
