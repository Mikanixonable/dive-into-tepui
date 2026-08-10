// マップモードのフォーカス対象(天体・ラグランジュ点)ラベルの算出と HUD マーカーへの反映。
import { Vec3, v3 } from '../../physics/vec3';
import { Attractor, AttractorId, OrbitingId } from '../../physics/attractor';
import { primaryOf } from '../../physics/solar-system';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import { celestialBodyName } from '../hud/frame-labels';
import { isOccluded } from '../../physics/occlusion';
import { BodyClassToggles, alwaysFullyVisibleIds, bodyIconLabel, systemMembersAt, visibleBodyIds } from '../celestial/body-visibility';
import { bodyClassOf } from '../celestial/body-class';
import { FOCUS_LABEL_PRIORITY_PX, LAGRANGE_MIN_CLEARANCE_RATIO } from '../const';

export interface FocusLabel {
  id: string;
  name: string;
  pos: Vec3;
  kind: 'body';
  isLagrange: boolean;
  // 天体の表示分類に基づくラベル優先度。数値が大きいほど優先して残す。
  readonly labelPriority: number;
  // 主星を 0 とする階層の深さ。一覧をこの順・この字下げで並べると親子関係がそのまま出る。
  depth: number;
  // このフレームでマーカーの点・名前をそれぞれ描くか。
  showIcon: boolean;
  showLabel: boolean;
  // ラベル衝突で隠された対象は、ダブルクリックのフォーカス対象にもしない。
  pickable: boolean;
}

// 惑星 > 準惑星 > 衛星・小惑星・彗星 > ラグランジュ点。
// 恒星は太陽系の基準点なので、惑星と同じ最上位として常に残す。
const LABEL_PRIORITY: Record<'star' | 'planet' | 'dwarf' | 'satellite' | 'smallBody' | 'lagrange', number> = {
  star: 4,
  planet: 4,
  dwarf: 3,
  satellite: 2,
  smallBody: 2,
  lagrange: 1,
};

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
      labels.push({
        id, name: celestialBodyName(id), pos: v3(0, 0, 0), kind: 'body', isLagrange: false,
        labelPriority: LABEL_PRIORITY[bodyClassOf(registry, id)], depth,
        showIcon: false, showLabel: false, pickable: true,
      });
      const primary = primaryOf(registry, id);
      const prefix = `${primary === null ? celestialBodyName(id) : celestialBodyName(primary)}-${celestialBodyName(id)}`;
      for (const n of pointsOf.get(id) ?? []) {
        labels.push({
          id: `${id}-l${n}`, name: `${prefix} L${n}`, pos: v3(0, 0, 0),
          kind: 'body', isLagrange: true, labelPriority: LABEL_PRIORITY.lagrange, depth: depth + 1,
          showIcon: false, showLabel: false, pickable: true,
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
  update(t: number, focusId: AttractorId | undefined, toggles: BodyClassToggles, cameraPos: Vec3): void {
    const ephemeris = this.ephemeris;
    const attractors = ephemeris.attractorsAt(t);
    // フォーカスを解除しても、カメラが実際にいる惑星系の衛星は消さない。カメラ位置の
    // 「近さ」を固定距離で判定せず、既存の重力系判定を使うことで、地球/月や木星/衛星の
    // 境界を同じ規則で扱える。
    const nearby = systemMembersAt(ephemeris.registry, cameraPos, attractors);
    // まず表示対象を決め、その中だけ座標を引く。ラグランジュ点は Icon/Label のどちらかが
    // 立っているときだけ。alwaysFullyVisibleIds に含まれる天体は Icon/Label とも常時 true。
    const visible = visibleBodyIds(ephemeris.registry, focusId, toggles, nearby);
    const always = alwaysFullyVisibleIds(ephemeris.registry, focusId, nearby, toggles);

    const positions: Record<string, Vec3> = {};
    const display: Record<string, { icon: boolean; label: boolean }> = {};
    for (const id of this.registryIds) {
      if (!visible.has(id)) continue;
      positions[id] = ephemeris.positionOf(id, t);
      display[id] = always.has(id) ? { icon: true, label: true } : bodyIconLabel(ephemeris.registry, toggles, id);
    }
    if (toggles.lagrangeVisible && (toggles.lagrangeIcon || toggles.lagrangeLabel)) {
      for (const { id, points } of this.lagrangeSources) {
        if (!visible.has(id)) continue;
        const l = ephemeris.lagrangeAt(id, t);
        for (const n of points) {
          positions[`${id}-l${n}`] = l[`L${n}`];
          display[`${id}-l${n}`] = { icon: toggles.lagrangeIcon, label: toggles.lagrangeLabel };
        }
      }
    }

    const shown: FocusLabel[] = [];
    for (const lbl of this.allLabels) {
      const pos = positions[lbl.id];
      if (pos === undefined) continue;
      lbl.pos = pos;
      const d = display[lbl.id]!;
      lbl.showIcon = d.icon;
      lbl.showLabel = d.label;
      lbl.pickable = true;
      shown.push(lbl);
    }
    this.shownLabels = shown;
    this.attractors = attractors;
  }

  // update が求めた座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 画面上で近接するラベルは優先度の低い方を隠す。
  syncLabels(project: ProjectFn, cameraPos: Vec3): void {
    // 実際に文字列を出すラベルだけを競合対象にする。同じ優先度同士は両方残し、
    // MarkerManager の通常の衝突緩和へ任せる。
    const projected: { label: FocusLabel; x: number; y: number }[] = [];
    for (const lbl of this.shownLabels) {
      if (isOccluded(cameraPos, lbl.pos, this.attractors)) continue;
      const p = project(lbl.pos);
      if (p.front && lbl.showLabel) projected.push({ label: lbl, x: p.x, y: p.y });
    }

    const hiddenByPriority = new Set<string>();
    for (let i = 0; i < projected.length; i++) {
      const a = projected[i]!;
      for (let j = i + 1; j < projected.length; j++) {
        const b = projected[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= FOCUS_LABEL_PRIORITY_PX) continue;
        if (a.label.labelPriority > b.label.labelPriority) hiddenByPriority.add(b.label.id);
        else if (b.label.labelPriority > a.label.labelPriority) hiddenByPriority.add(a.label.id);
      }
    }

    const shownIds: string[] = [];
    for (const lbl of this.shownLabels) {
      shownIds.push(lbl.id);
      lbl.pickable = !hiddenByPriority.has(lbl.id);
      if (isOccluded(cameraPos, lbl.pos, this.attractors)) {
        lbl.pickable = false;
        this.markerManager.hide(lbl.id);
        continue;
      }
      if (hiddenByPriority.has(lbl.id)) {
        this.markerManager.hide(lbl.id);
        continue;
      }
      this.markerManager.setPosition(
        lbl.id, 'mk-poi', lbl.showIcon ? '●' : '', lbl.pos, project, lbl.showLabel ? lbl.name : '',
      );
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
