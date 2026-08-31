// 1つのオブジェクトの軌道が中心天体の赤道面を横切る2点(EqAN/EqDN)の算出と、△▽ マーカー
// としての表示・被選択物としての公開。
import { strongestAttractor } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';
import { FrameAnchorSource, ReferenceFrame, unbakeToDisplayPoint } from '../../physics/frame';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../math/vec3';
import { solveEquatorCrossings } from '../../physics/orbit-solvers';
import { TimeLabelSetting, elementTimeLabel } from '../hud/orbit/calendar-ticks';
import type { MarkerManager } from './marker-manager';
import { ORBIT_POINT_GLYPH } from './marker-glyphs';
import type { ProjectFn } from '../camera/camera-system';
import { MapPickable } from '../pickable/map-pickable';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

// 交点アイコン。右クリックの被選択物であると同時に、マーカーに出す短いラベルを持つ。
interface EqNodeIcon extends MapPickable {
  readonly label: string;
}

export class EquatorNodeMarkerPair {
  private icons: readonly EqNodeIcon[] = [];
  // update が求めた時点の CelestialMotion[]。sync でのマップビュー遮蔽判定に使う。
  private celestialBodies: readonly CelestialMotion[] = [];
  // celestialBodies の位置を厳密に引く時刻。
  private celestialBodiesPivot = 0;

  private readonly anKey: string;
  private readonly dnKey: string;

  constructor(private readonly owner: DynamicEntity, private readonly markerManager: MarkerManager) {
    this.anKey = `eqan-${owner.id}`;
    this.dnKey = `eqdn-${owner.id}`;
  }

  // 解析軌道楕円の上に交点を置く。楕円は中心天体に固定して描かれるので、交点もその天体の
  // 慣性系で表示時刻へ写す。
  updateOnEllipse(
    displayTime: number, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
    timeLabel: TimeLabelSetting,
  ): void {
    this.update(
      null, displayTime, celestialSystem, frameAnchors,
      this.owner.stateAt(displayTime, celestialSystem), [], timeLabel,
    );
  }

  // 表示中の折れ線の上に交点を置く。paths(区間ごとのサンプル列、時刻昇順)が空なら state の
  // 軌道要素から求める。位置は折れ線と同じ frame で写す。
  updateOnPath(
    frame: ReferenceFrame, displayTime: number, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
    state: KinematicState, paths: readonly (readonly KinematicState[])[],
    timeLabel: TimeLabelSetting,
  ): void {
    this.update(frame, displayTime, celestialSystem, frameAnchors, state, paths, timeLabel);
  }

  // 交点を求め直す。frame は交点位置を表示時刻へ写す座標系で、null なら中心天体の慣性系
  // (= 解析軌道楕円の置き方)。
  private update(
    frame: ReferenceFrame | null, displayTime: number, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
    state: KinematicState | null, paths: readonly (readonly KinematicState[])[],
    timeLabel: TimeLabelSetting,
  ): void {
    this.icons = [];
    this.celestialBodies = frameAnchors.bodies;
    this.celestialBodiesPivot = frameAnchors.bodiesPivot;
    if (state === null) return;
    // 中心天体は state 自身の時刻の天体位置で選ぶ — 解析楕円は displayTime、折れ線は
    // simTime の状態ベクトルから作るので、時刻を揃えないと中心の選定だけが別の瞬間になる。
    const centerPivot = state.t;
    const center = strongestAttractor(state.r, celestialSystem.celestialMotions, centerPivot);
    const eqNormal = center.degree2At(centerPivot)?.pole;
    if (!eqNormal) return;

    const displayFrame = frame ?? celestialSystem.frames.frameFor(center.id);
    const unbakeTf = celestialSystem.frames.transformAt(displayFrame, displayTime, frameAnchors);
    const crossings = solveEquatorCrossings(
      state, center, centerPivot, eqNormal, paths,
      (t) => celestialSystem.stateAt(center.id, t).r);
    if (!crossings) return;

    const centerName = celestialSystem.nameOf(center.id);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, celestialSystem.frames.transformAt(displayFrame, t, frameAnchors), r);

    // PREDICT パネルの「軌道要素の時刻を表示」がONのときだけ通過時刻を併記する。
    const labelWithTime = (base: string, t: number): string =>
      timeLabel.show ? `${base} ${elementTimeLabel(t, timeLabel)}` : base;
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
          icon.id, 'mk-node', glyph, icon.pos, project, cameraPos,
          this.celestialBodies, this.celestialBodiesPivot, true, icon.label,
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
