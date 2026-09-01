// 1つのオブジェクトの軌道が中心天体の赤道面を横切る2点(EqAN/EqDN)の算出と、△▽ マーカー
// としての表示・被選択物としての公開。
import { strongestAttractor } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';
import { FrameAnchorSource, ReferenceFrame, unbakeToDisplayPoint } from '../../physics/frame';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../math/vec3';
import { solveEquatorCrossings } from '../../physics/orbit-solvers';
import { TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { EquatorNodeMarker } from './equator-node-marker';
import type { MarkerManager } from './marker-manager';
import type { ProjectFn } from '../camera/camera-system';
import { MapPickable } from '../pickable/map-pickable';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

export class EquatorNodeMarkerPair {
  private readonly ascending: EquatorNodeMarker;
  private readonly descending: EquatorNodeMarker;
  // update が求めた時点の CelestialMotion[]。sync でのマップビュー遮蔽判定に使う。
  private celestialBodies: readonly CelestialMotion[] = [];
  // celestialBodies の位置を厳密に引く時刻。
  private celestialBodiesPivot = 0;
  // 通過時刻ラベルの設定。update ごとに渡され、sync のラベル組み立てで読む。
  private timeLabel: TimeLabelSetting = {
    mode: 'absolute', show: false, nowSimTime: 0, epochUnixSec: 0,
  };
  // 直前の sync 以降に update が交点を書き込んだか。求め直されなかったフレームで交点を
  // 捨てるために持つ。
  private solvedSinceSync = false;

  // owner は交点を求める対象の軌道の持ち主。昇交点・降交点のマーカーを1つずつ持ち続ける。
  constructor(private readonly owner: DynamicEntity, private readonly markerManager: MarkerManager) {
    this.ascending = new EquatorNodeMarker(owner.id, 'ascending');
    this.descending = new EquatorNodeMarker(owner.id, 'descending');
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
    this.clearCrossings();
    this.celestialBodies = frameAnchors.bodies;
    this.celestialBodiesPivot = frameAnchors.bodiesPivot;
    this.timeLabel = timeLabel;
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

    this.ascending.place(
      toDisplay(crossings.asc.r, crossings.asc.t), crossings.asc.t, this.owner.name, centerName);
    this.descending.place(
      toDisplay(crossings.desc.r, crossings.desc.t), crossings.desc.t, this.owner.name, centerName);
    this.solvedSinceSync = true;
  }

  // 交点を、このフレームは求まらなかった状態にする。
  private clearCrossings(): void {
    this.ascending.place(null, null, null, null);
    this.descending.place(null, null, null, null);
  }

  // 右クリック対象として公開する EqAN/EqDN アイコン(交点が求まっていなければ空)。
  mapPickables(): readonly MapPickable[] {
    return [this.ascending, this.descending].filter((marker) => !marker.gone);
  }

  // △▽ マーカーを update が求めた位置に置く。求め直されなかったフレームは交点を捨てて隠す。
  sync(project: ProjectFn, show: boolean, cameraPos: Vec3): void {
    if (!this.solvedSinceSync) this.clearCrossings();
    this.solvedSinceSync = false;
    for (const marker of [this.ascending, this.descending]) {
      if (!show) this.markerManager.hide(marker.id);
      else {
        marker.sync(
          this.markerManager, project, cameraPos, this.celestialBodies, this.celestialBodiesPivot,
          this.timeLabel,
        );
      }
    }
  }

  // マーカー要素ごと取り除く。
  dispose(): void {
    this.markerManager.remove(this.ascending.id);
    this.markerManager.remove(this.descending.id);
  }
}
