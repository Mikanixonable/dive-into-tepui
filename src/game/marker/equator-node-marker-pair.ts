// 1つのオブジェクトの軌道が中心天体の赤道面を横切る2点(EqAN/EqDN)の算出と、△▽ マーカー
// としての表示・被選択物としての公開。
import { CelestialBody, strongestAttractor } from '../../physics/celestial-body';
import { ReferenceFrame, unbakeToDisplayPoint } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../physics/vec3';
import { solveEquatorCrossings } from '../../physics/orbit-solvers';
import { celestialBodyName } from '../hud/frame-labels';
import type { MarkerManager } from './marker-manager';
import { ORBIT_POINT_GLYPH } from './marker-glyphs';
import type { ProjectFn } from '../camera/camera-system';
import { MapPickable } from '../map-pickable';
import type { GameEntity } from '../game-entity/game-entity';

// 交点アイコン。右クリックの被選択物であると同時に、マーカーに出す短いラベルを持つ。
interface EqNodeIcon extends MapPickable {
  readonly label: string;
}

export class EquatorNodeMarkerPair {
  private icons: readonly EqNodeIcon[] = [];
  // update が求めた時点の CelestialBody[]。sync でのマップビュー遮蔽判定に使う。
  private celestialBodies: readonly CelestialBody[] = [];

  private readonly anKey: string;
  private readonly dnKey: string;

  constructor(private readonly owner: GameEntity, private readonly markerManager: MarkerManager) {
    this.anKey = `eqan-${owner.id}`;
    this.dnKey = `eqdn-${owner.id}`;
  }

  // 解析軌道楕円の上に交点を置く。楕円は中心天体に固定して描かれるので、交点もその天体の
  // 慣性系で表示時刻へ写す。
  updateOnEllipse(displayTime: number, ephemeris: Ephemeris): void {
    this.update(null, displayTime, ephemeris, this.owner.state, []);
  }

  // 表示中の折れ線の上に交点を置く。paths(区間ごとのサンプル列、時刻昇順)が空なら state の
  // 軌道要素から求める。位置は折れ線と同じ frame で写す。
  updateOnPath(
    frame: ReferenceFrame, displayTime: number, ephemeris: Ephemeris,
    state: KinematicState, paths: readonly (readonly KinematicState[])[],
  ): void {
    this.update(frame, displayTime, ephemeris, state, paths);
  }

  // 交点を求め直す。frame は交点位置を表示時刻へ写す座標系で、null なら中心天体の慣性系
  // (= 解析軌道楕円の置き方)。
  private update(
    frame: ReferenceFrame | null, displayTime: number, ephemeris: Ephemeris,
    state: KinematicState, paths: readonly (readonly KinematicState[])[],
  ): void {
    this.icons = [];
    this.celestialBodies = ephemeris.celestialBodiesAt(displayTime);
    const center = strongestAttractor(state.r, ephemeris.celestialBodiesAt(state.t));
    const eqNormal = center.degree2?.pole;
    if (!eqNormal) return;

    const displayFrame = frame ?? ephemeris.frameFor(center.id);
    const unbakeTf = ephemeris.frameTransformAt(displayFrame, displayTime, this.celestialBodies);
    const crossings = solveEquatorCrossings(state, center, eqNormal, paths, (t) => ephemeris.positionOf(center.id, t));
    if (!crossings) return;

    const centerName = celestialBodyName(center.id);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, ephemeris.frameTransformAt(displayFrame, t, this.celestialBodies), r);

    this.icons = [
      {
        id: this.anKey, name: `${this.owner.name}の${centerName}赤道昇交点`, kind: 'eqnode',
        ownerName: this.owner.name,
        pos: toDisplay(crossings.asc.r, crossings.asc.t), time: crossings.asc.t, label: 'EqAN',
      },
      {
        id: this.dnKey, name: `${this.owner.name}の${centerName}赤道降交点`, kind: 'eqnode',
        ownerName: this.owner.name,
        pos: toDisplay(crossings.desc.r, crossings.desc.t), time: crossings.desc.t, label: 'EqDN',
      },
    ];
  }

  // 右クリック対象として公開する EqAN/EqDN アイコン(交点が求まっていなければ空)。
  mapPickables(): readonly MapPickable[] {
    return this.icons;
  }

  // △▽ マーカーを update が求めた位置に置き、そのフレームぶんの交点を捨てる。
  sync(project: ProjectFn, show: boolean, cameraPos: Vec3): void {
    for (const icon of this.icons) {
      const glyph = icon.id === this.anKey ? ORBIT_POINT_GLYPH.ascendingNode : ORBIT_POINT_GLYPH.descendingNode;
      if (!show) {
        this.markerManager.hide(icon.id);
      } else {
        this.markerManager.setNodePosition(
          icon.id, 'mk-node', glyph, icon.pos, project, cameraPos, this.celestialBodies, true, icon.label,
        );
      }
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
}
