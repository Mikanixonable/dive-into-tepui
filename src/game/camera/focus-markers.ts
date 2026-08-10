// マップモードのフォーカス対象(天体・ラグランジュ点)ラベルの算出と HUD マーカーへの反映。
import { Vec3, v3 } from '../../physics/vec3';
import { Attractor, AttractorId, OrbitingId } from '../../physics/attractor';
import { primaryOf } from '../../physics/solar-system';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import { celestialBodyName } from '../hud/frame-labels';
import { isOccluded } from '../../physics/occlusion';
import { BodyClassToggles, visibleBodyIds } from '../celestial/body-visibility';
import { bodyClassOf } from '../celestial/body-class';
import { FOCUS_LABEL_PRIORITY_PX, LAGRANGE_MIN_CLEARANCE_RATIO } from '../const';

export interface FocusLabel {
  id: string;
  name: string;
  pos: Vec3;
  kind: 'body';
  isLagrange: boolean;
  // 主星を 0 とする階層の深さ。一覧をこの順・この字下げで並べると親子関係がそのまま出る。
  depth: number;
}

export class FocusMarkers {
  // 天体本体1つにつき1ラベル、ラグランジュ点が力学的に意味を持つ天体にはさらに L1〜L5 の
  // うち成立する点ぶんのラベルが並ぶ(表示名は「中心天体名-自分の名 Ln」)。
  private readonly registryIds: readonly AttractorId[];
  // ラグランジュ点ラベルを持つ天体と、そのうち成立する点の番号。
  private readonly lagrangeSources: readonly { readonly id: OrbitingId; readonly points: readonly (1 | 2 | 3 | 4 | 5)[] }[];
  private readonly allLabels: readonly FocusLabel[];
  // このフレームで表示する対象に絞ったラベル。
  private shownLabels: readonly FocusLabel[] = [];
  // 直前のフレームに表示していたラベル id(集合から外れたものを隠すため)。
  private prevShownIds: readonly string[] = [];

  private attractors: readonly Attractor[] = [];

  // レジストリからラベルの全集合を1度だけ組む。ラグランジュ点は5点まとめてではなく、
  // 共線点・三角点それぞれの成立条件を満たす点だけを持たせる。
  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {
    const registry = ephemeris.registry;
    this.registryIds = Object.keys(registry);
    this.lagrangeSources = this.registryIds.flatMap((id) => {
      if (registry[id]!.kind === 'star') return [];
      const collinear = ephemeris.hasUsableCollinearPoints(id, LAGRANGE_MIN_CLEARANCE_RATIO);
      // 小天体・準惑星は数が多く、L3・L4・L5 まで並べるとラベルが密集しすぎる。
      const cls = bodyClassOf(registry, id);
      const minor = cls === 'smallBody' || cls === 'dwarf';
      const triangular = !minor && ephemeris.hasStableTriangularPoints(id);
      const points = [
        ...(collinear ? (minor ? [1, 2] as const : [1, 2, 3] as const) : []),
        ...(triangular ? [4, 5] as const : []),
      ];
      return points.length === 0 ? [] : [{ id, points }];
    });

    // 親を先に、その子を続けて並べる。一覧はこの順をそのまま使うので、並べ替えを持たない。
    // レジストリは実行時に差し替えられるので、親子関係が循環していても停止し、同じ天体を
    // 二度並べないよう追加済みを覚えておく。
    const labels: FocusLabel[] = [];
    const added = new Set<AttractorId>();
    const pointsOf = new Map(this.lagrangeSources.map((s) => [s.id, s.points]));
    const appendBody = (id: AttractorId, depth: number): void => {
      if (added.has(id)) return;
      added.add(id);
      labels.push({ id, name: celestialBodyName(id), pos: v3(0, 0, 0), kind: 'body', isLagrange: false, depth });
      const primary = primaryOf(registry, id);
      const prefix = `${primary === null ? celestialBodyName(id) : celestialBodyName(primary)}-${celestialBodyName(id)}`;
      for (const n of pointsOf.get(id) ?? []) {
        labels.push({
          id: `${id}-l${n}`, name: `${prefix} L${n}`, pos: v3(0, 0, 0),
          kind: 'body', isLagrange: true, depth: depth + 1,
        });
      }
      for (const child of this.registryIds) {
        if (child !== id && primaryOf(registry, child) === id) appendBody(child, depth + 1);
      }
    };
    for (const id of this.registryIds) {
      if (primaryOf(registry, id) === null) appendBody(id, 0);
    }
    // 主星を持たない孤立した天体(親が登録されていないレジストリ・循環したレジストリ)も落とさない。
    for (const id of this.registryIds) appendBody(id, 0);
    this.allLabels = labels;
  }

  // このフレームで表示するラベル(ピック候補でもある)。
  get labels(): readonly FocusLabel[] {
    return this.shownLabels;
  }

  // 表示時刻 t の各ラベル座標を求め直す。表示対象の外にある天体は座標計算ごと飛ばす —
  // 登録天体が増えるほど lagrangeAt(1天体あたり positionOf 2回 + 回転系1回)が効くため。
  update(t: number, focusId: AttractorId, toggles: BodyClassToggles): void {
    const ephemeris = this.ephemeris;
    // まず表示対象を決め、その中だけ座標を引く。ラグランジュ点はトグルが立っているときだけ。
    const visible = visibleBodyIds(ephemeris.registry, focusId, toggles);

    const positions: Record<string, Vec3> = {};
    for (const id of this.registryIds) {
      if (visible.has(id)) positions[id] = ephemeris.positionOf(id, t);
    }
    if (toggles.lagrange) {
      for (const { id, points } of this.lagrangeSources) {
        if (!visible.has(id)) continue;
        const l = ephemeris.lagrangeAt(id, t);
        for (const n of points) positions[`${id}-l${n}`] = l[`L${n}`];
      }
    }

    const shown: FocusLabel[] = [];
    for (const lbl of this.allLabels) {
      const pos = positions[lbl.id];
      if (pos === undefined) continue;
      lbl.pos = pos;
      shown.push(lbl);
    }
    this.shownLabels = shown;
    this.attractors = ephemeris.attractorsAt(t);
  }

  // update が求めた座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 天体ラベルと画面上で近接するラグランジュ点ラベルは天体側を優先して隠す。
  syncLabels(project: ProjectFn, cameraPos: Vec3): void {
    // 先に天体ラベルの画面位置を集めてから、ラグランジュ点ラベルの間引き判定に使う。
    const shownBodyScreenPos: { x: number; y: number }[] = [];
    for (const lbl of this.shownLabels) {
      if (lbl.isLagrange) continue;
      if (isOccluded(cameraPos, lbl.pos, this.attractors)) continue;
      const p = project(lbl.pos);
      if (p.front) shownBodyScreenPos.push(p);
    }

    const shownIds: string[] = [];
    for (const lbl of this.shownLabels) {
      shownIds.push(lbl.id);
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
    const nowShown = new Set(shownIds);
    for (const id of this.prevShownIds) if (!nowShown.has(id)) this.markerManager.hide(id);
    this.prevShownIds = shownIds;
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    for (const lbl of this.allLabels) this.markerManager.hide(lbl.id);
  }
}
