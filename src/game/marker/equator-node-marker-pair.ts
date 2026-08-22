// 1つのオブジェクトの軌道が中心天体の赤道面を横切る2点(EqAN/EqDN)の算出と、△▽ マーカー
// としての表示・被選択物としての公開。
import { CelestialBody, strongestAttractor } from '../../physics/celestial-body';
import { FrameAnchorSource, ReferenceFrame, unbakeToDisplayPoint } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../physics/vec3';
import { solveEquatorCrossings } from '../../physics/orbit-solvers';
import { celestialBodyName } from '../hud/frame-labels';
import { TickLabelMode, elementTimeLabel } from '../hud/calendar-ticks';
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

  // 交点を求め直す。
  update(
    frame: ReferenceFrame, displayTime: number, ephemeris: Ephemeris, frameAnchors: FrameAnchorSource,
    timeLabel: { readonly mode: TickLabelMode; readonly show: boolean; readonly nowSimTime: number },
    state: KinematicState = this.owner.state, samples: readonly KinematicState[] | null = null,
  ): void {
    this.icons = [];
    this.celestialBodies = frameAnchors.bodies;
    const center = strongestAttractor(state.r, ephemeris.celestialBodiesAt(state.t));
    const eqNormal = center.degree2?.pole;
    if (!eqNormal) return;

    const unbakeTf = ephemeris.frameTransformAt(frame, displayTime, frameAnchors);
    const crossings = solveEquatorCrossings(state, center, eqNormal, samples, (t) => ephemeris.positionOf(center.id, t));
    if (!crossings) return;

    const centerName = celestialBodyName(center.id);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, ephemeris.frameTransformAt(frame, t, frameAnchors), r);

    // PREDICT パネルの「軌道要素の時刻を表示」がONのときだけ通過時刻を併記する。
    const labelWithTime = (base: string, t: number): string =>
      timeLabel.show ? `${base} ${elementTimeLabel(t, timeLabel.mode, timeLabel.nowSimTime)}` : base;
    this.icons = [
      {
        id: this.anKey, name: `${this.owner.name}の${centerName}赤道昇交点`, kind: 'eqnode',
        ownerName: this.owner.name,
        pos: toDisplay(crossings.asc.r, crossings.asc.t), time: crossings.asc.t,
        label: labelWithTime('EqAN', crossings.asc.t),
      },
      {
        id: this.dnKey, name: `${this.owner.name}の${centerName}赤道降交点`, kind: 'eqnode',
        ownerName: this.owner.name,
        pos: toDisplay(crossings.desc.r, crossings.desc.t), time: crossings.desc.t,
        label: labelWithTime('EqDN', crossings.desc.t),
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
