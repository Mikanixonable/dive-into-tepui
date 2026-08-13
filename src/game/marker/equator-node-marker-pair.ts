// 1つのオブジェクトの軌道が中心天体の赤道面を横切る2点(EqAN/EqDN)の算出と、△▽ マーカー
// としての表示・被選択物としての公開。
//
// update が求めた交点はそのフレーム限りで、sync は置いたあとに捨てる。出す対象を選ぶ側は
// update を呼ぶだけでよく、選ばれなくなったフレームでは自動的に隠れる。
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../../physics/elements';
import { Attractor, orbitalElementsOf, frameOfAttractor, strongestAttractor } from '../../physics/attractor';
import { findEquatorCrossings } from '../../physics/trajectory-features';
import { isOccluded } from '../../physics/occlusion';
import { ReferenceFrame, frameKinematicState, toFramePoint, toFrameState, toInertialPoint, toInertialState } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../physics/vec3';
import { celestialBodyName } from '../hud/frame-labels';
import type { MarkerManager } from './marker-manager';
import { ORBIT_POINT_GLYPH } from './marker-glyphs';
import type { ProjectFn } from '../camera/camera-system';
import { MapPickable } from '../map-pick';
import type { GameEntity } from '../game-entity/game-entity';

// 交点アイコン。右クリックの被選択物であると同時に、マーカーに出す短いラベルを持つ。
interface EqNodeIcon extends MapPickable {
  readonly label: string;
}

export class EquatorNodeMarkerPair {
  private icons: readonly EqNodeIcon[] = [];
  // update が求めた時点の Attractor[]。sync でのマップビュー遮蔽判定に使う。
  private attractors: readonly Attractor[] = [];

  private readonly anKey: string;
  private readonly dnKey: string;

  constructor(private readonly owner: GameEntity, private readonly markerManager: MarkerManager) {
    this.anKey = `eqan-${owner.id}`;
    this.dnKey = `eqdn-${owner.id}`;
  }

  // 交点を求め直す。state は所有者の軌道を代表する状態(既定は現在状態)、samples を渡すと
  // その折れ線を走査して交点を求め、省略すると state の軌道要素から解析的に求める — 解析楕円
  // (OrbitLine)で描かれる軌道は解析計算のままアイコンを線に一致させ、積分折れ線で描かれる
  // 軌道は折れ線側から拾う。中心天体が自転軸をモデル化していない(太陽・木星など)、または
  // 軌道面が赤道面とほぼ一致する場合は何も出さない。位置は sample 時刻で bake し displayTime で
  // un-bake して frame へ変換する。
  update(
    frame: ReferenceFrame, displayTime: number, ephemeris: Ephemeris,
    state: KinematicState = this.owner.state, samples: readonly KinematicState[] | null = null,
  ): void {
    this.icons = [];
    this.attractors = ephemeris.attractorsAt(displayTime);
    const center = strongestAttractor(state.r, ephemeris.attractorsAt(state.t));
    const eqNormal = center.degree2?.pole;
    if (!eqNormal) return;

    // un-bake は表示時刻に固定なので、両交点で同じ変換を使い回す。
    const unbakeTf = ephemeris.frameTransformAt(frame, displayTime, this.attractors);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      toInertialPoint(unbakeTf, toFramePoint(ephemeris.frameTransformAt(frame, t, this.attractors), r));

    const crossings = samples
      ? this.sampledCrossings(samples, center, eqNormal)
      : this.analyticCrossings(state, center, eqNormal);
    if (!crossings) return;

    const centerName = celestialBodyName(center.id);
    this.icons = [
      {
        id: this.anKey, name: `${this.owner.name}の${centerName}赤道昇交点`, kind: 'eqnode',
        pos: toDisplay(crossings.asc.r, crossings.asc.t), time: crossings.asc.t, label: 'EqAN',
      },
      {
        id: this.dnKey, name: `${this.owner.name}の${centerName}赤道降交点`, kind: 'eqnode',
        pos: toDisplay(crossings.desc.r, crossings.desc.t), time: crossings.desc.t, label: 'EqDN',
      },
    ];
  }

  // 右クリック対象として公開する EqAN/EqDN アイコン(交点が求まっていなければ空)。
  mapPickables(): readonly MapPickable[] {
    return this.icons;
  }

  // △▽ マーカーを update が求めた位置に置き、そのフレームぶんの交点を捨てる。show=false、
  // 交点が無い、または天体に遮蔽されて画面上見えていない点は隠す。
  sync(project: ProjectFn, show: boolean, cameraPos: Vec3): void {
    for (const icon of this.icons) {
      const glyph = icon.id === this.anKey ? ORBIT_POINT_GLYPH.ascendingNode : ORBIT_POINT_GLYPH.descendingNode;
      if (!show || isOccluded(cameraPos, icon.pos, this.attractors)) this.markerManager.hide(icon.id);
      else this.markerManager.setPosition(icon.id, 'mk-node', glyph, icon.pos, project, icon.label);
    }
    if (this.icons.length === 0) {
      this.markerManager.hide(this.anKey);
      this.markerManager.hide(this.dnKey);
    }
    this.icons = [];
  }

  // マーカー要素ごと取り除く。
  dispose(): void {
    this.markerManager.remove(this.anKey);
    this.markerManager.remove(this.dnKey);
  }

  // 積分折れ線を走査して求めた昇交点・降交点。両方揃わなければ null。
  private sampledCrossings(
    samples: readonly KinematicState[], center: Attractor, eqNormal: Vec3,
  ): { asc: KinematicState; desc: KinematicState } | null {
    const { ascending, descending } = findEquatorCrossings(samples, center, eqNormal);
    return ascending && descending ? { asc: ascending, desc: descending } : null;
  }

  // 軌道要素から解析的に求めた昇交点・降交点(位置は絶対 ECI、時刻は state からの飛行時間)。
  // 軌道面が赤道面とほぼ一致していれば節線が定まらないので null。
  private analyticCrossings(
    state: KinematicState, center: Attractor, eqNormal: Vec3,
  ): { asc: KinematicState; desc: KinematicState } | null {
    const el = orbitalElementsOf(state, center);
    const nodes = el && nodeAnomalies(el, eqNormal);
    if (!el || !nodes) return null;
    const tf = frameOfAttractor(center);
    const relative = toFrameState(tf, state);
    const nodeState = (nu: number): KinematicState => {
      const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
      const t = state.t + (isFinite(dt) ? dt : 0);
      return toInertialState(tf, t, frameKinematicState(positionOnOrbit(el, nu), relative.v));
    };
    return { asc: nodeState(nodes.asc), desc: nodeState(nodes.desc) };
  }
}
