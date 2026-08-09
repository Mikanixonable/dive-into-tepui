// マップ上で選ばれた複数オブジェクト(操作艦・航法ターゲット・戦闘ターゲット)それぞれの
// 軌道が中心天体の赤道面を横切る点(EqAN/EqDN)の算出とマーカー表示、被選択物としての公開。
// どの対象を出すかは単一のオブジェクトでは決められない(Game が役割ごとに source を組む)ので
// GroupedMarkers/LeadMarkers と同じ理由で marker/ に置く。
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../../physics/elements';
import { Attractor, orbitalElementsOf, frameOfAttractor, strongestAttractor } from '../../physics/attractor';
import { findEquatorCrossings } from '../../physics/trajectory-features';
import { isOccluded } from '../../physics/occlusion';
import { ReferenceFrame, frameKinematicState, toFramePoint, toFrameState, toInertialPoint, toInertialState } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../physics/vec3';
import { celestialBodyName } from '../hud/frame-labels';
import { MarkerManager } from './marker-manager';
import { ProjectFn } from '../camera/camera-system';
import { MapPickable } from '../map-pick';

// 交点を求める対象。state はその軌道を代表する状態(自艦なら計画の最終区間の起点、他は実状態)。
// samples を渡すとその折れ線を走査して交点を求め、省略すると state の軌道要素から解析的に
// 求める — 敵・基地は描画そのものが OrbitLine(解析楕円)なので解析計算のままアイコンを
// その線に一致させ、自艦の計画軌道は PlanArc の積分折れ線で描かれるので折れ線側から拾う。
export interface EqNodeSource {
  readonly id: string;
  readonly name: string;
  readonly state: KinematicState;
  readonly samples?: readonly KinematicState[];
}

interface EqNodeIcon extends MapPickable {
  readonly label: string;
}

interface EqNodePair {
  readonly sourceId: string;
  readonly an: EqNodeIcon;
  readonly dn: EqNodeIcon;
}

export class EquatorNodeMarkers {
  private pairs: readonly EqNodePair[] = [];
  private lastKeys: readonly string[] = [];
  // update が求めた時点の Attractor[]。sync でのマップビュー遮蔽判定に使う。
  private attractors: readonly Attractor[] = [];

  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {}

  // source ごとに、中心天体の赤道面との交点(EqAN/EqDN)を求め直す。samples を持つ source
  // (自艦の計画軌道)は積分折れ線の走査、それ以外(解析楕円で描かれる敵・基地・航法ターゲット)
  // は軌道要素から解析的に求める。中心天体が自転軸をモデル化していない(degree2 が無い、
  // 太陽・木星など)source は出さない。位置は sample 時刻 t で bake し表示時刻 displayTime で
  // un-bake して frame へ変換する(plan-path.ts の toDisplay と同じ手順を自前で行う)。
  update(sources: readonly EqNodeSource[], frame: ReferenceFrame, displayTime: number): void {
    this.attractors = this.ephemeris.attractorsAt(displayTime);
    const pairs: EqNodePair[] = [];
    for (const source of sources) {
      const state = source.state;
      const center = strongestAttractor(state.r, this.ephemeris.attractorsAt(state.t));
      const eqNormal = center.degree2?.pole;
      if (!eqNormal) continue;

      const toDisplay = (r: Vec3, t: number): Vec3 => {
        const bakeTf = this.ephemeris.frameTransformAt(frame, t, this.attractors);
        const unbakeTf = this.ephemeris.frameTransformAt(frame, displayTime, this.attractors);
        return toInertialPoint(unbakeTf, toFramePoint(bakeTf, r));
      };

      let an: { pos: Vec3; time: number } | null;
      let dn: { pos: Vec3; time: number } | null;
      if (source.samples) {
        const crossings = findEquatorCrossings(source.samples, center, eqNormal);
        an = crossings.ascending && { pos: toDisplay(crossings.ascending.r, crossings.ascending.t), time: crossings.ascending.t };
        dn = crossings.descending && { pos: toDisplay(crossings.descending.r, crossings.descending.t), time: crossings.descending.t };
      } else {
        const tf = frameOfAttractor(center);
        const relative = toFrameState(tf, state);
        const el = orbitalElementsOf(state, center);
        const nodes = el && nodeAnomalies(el, eqNormal);
        const nodePosition = (nu: number): { pos: Vec3; time: number } => {
          const dt = tofBetween(el!, trueAnomalyAt(el!, relative.r), nu);
          const t = state.t + (isFinite(dt) ? dt : 0);
          const relativeState = frameKinematicState(positionOnOrbit(el!, nu), relative.v);
          return { pos: toDisplay(toInertialState(tf, t, relativeState).r, t), time: t };
        };
        an = nodes ? nodePosition(nodes.asc) : null;
        dn = nodes ? nodePosition(nodes.desc) : null;
      }
      if (!an || !dn) continue;

      const centerName = celestialBodyName(center.id);
      pairs.push({
        sourceId: source.id,
        an: {
          id: `${source.id}-eqan`, name: `${source.name}の${centerName}赤道昇交点`, kind: 'eqnode',
          pos: an.pos, time: an.time, label: 'EqAN',
        },
        dn: {
          id: `${source.id}-eqdn`, name: `${source.name}の${centerName}赤道降交点`, kind: 'eqnode',
          pos: dn.pos, time: dn.time, label: 'EqDN',
        },
      });
    }
    this.pairs = pairs;
  }

  // 右クリック対象として公開する EqAN/EqDN アイコン。
  mapPickables(): readonly MapPickable[] {
    return this.pairs.flatMap((p) => [p.an, p.dn]);
  }

  // △▽ 交点マーカーを update が求めた位置に置く。show=false なら全て隠す。対象の増減で
  // マーカーキーの集合自体が変わるので、前フレーム出していて今フレーム出さないキーは
  // hide ではなく remove で消す。show=true(マップビュー)のときは、天体に遮蔽されて
  // 画面上見えていない点を hide する。
  sync(project: ProjectFn, show: boolean, cameraPos: Vec3): void {
    const keys = show ? this.pairs.map((p) => p.sourceId) : [];
    if (show) {
      for (const p of this.pairs) {
        if (isOccluded(cameraPos, p.an.pos, this.attractors)) this.markerManager.hide(`eqan-${p.sourceId}`);
        else this.markerManager.setPosition(`eqan-${p.sourceId}`, 'mk-node', '△', p.an.pos, project, p.an.label);
        if (isOccluded(cameraPos, p.dn.pos, this.attractors)) this.markerManager.hide(`eqdn-${p.sourceId}`);
        else this.markerManager.setPosition(`eqdn-${p.sourceId}`, 'mk-node', '▽', p.dn.pos, project, p.dn.label);
      }
    }
    for (const id of this.lastKeys) {
      if (!keys.includes(id)) {
        this.markerManager.remove(`eqan-${id}`);
        this.markerManager.remove(`eqdn-${id}`);
      }
    }
    this.lastKeys = keys;
  }
}
