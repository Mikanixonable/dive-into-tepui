// 1つのオブジェクトの軌道が中心天体の赤道面を横切る2点(EqAN/EqDN)の算出と、△▽ マーカー
// としての表示・被選択物としての公開。
import { strongestAttractor } from '../../physics/attractor';
import { FrameAnchorSource, ReferenceFrame, unbakeToDisplayPoint } from '../../physics/frame';
import type { KinematicState } from '../../physics/kinematic-state';
import { Vec3 } from '../../math/vec3';
import { solveEquatorCrossings } from '../../physics/orbit-solvers';
import { TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { EquatorNodeMarker } from './equator-node-marker';
import type { MarkerSlots } from './marker-slots';
import { ObjectPickable } from '../pickable/object-pickable';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { CelestialBody } from '../../physics/celestial-body';
import type { ProjectFn } from '../../math/projection';

// 画面に出ている折れ線と、それが載っている座標系。
export interface DisplayedPath {
  readonly frame: ReferenceFrame;
  // 区間ごとのサンプル列、時刻昇順。
  readonly samples: readonly (readonly KinematicState[])[];
}

// ある個体について、いま画面に折れ線が出ているかを答える口。null は折れ線が出ていない
// ことを意味し、その個体には解析軌道楕円が出ている。
interface DisplayedPathSource {
  displayedPathOf(ownerId: string): DisplayedPath | null;
}

// 赤道交点を解くのに要る、そのフレームの材料。個体によって変わらないものだけを持ち、
// 個体ごとの違いは paths が答える。
export interface EquatorNodeInputs {
  readonly displayTime: number;
  readonly celestialBodies: CelestialBodies;
  readonly frameAnchors: FrameAnchorSource;
  readonly paths: DisplayedPathSource;
}

export class EquatorNodeMarkerPair {
  private readonly ascending: EquatorNodeMarker;
  private readonly descending: EquatorNodeMarker;

  // 所有個体に一意な昇交点・降交点マーカーを1つずつ作る。
  constructor(private readonly ownerId: string, private readonly markers: MarkerSlots) {
    this.ascending = new EquatorNodeMarker(ownerId, 'ascending');
    this.descending = new EquatorNodeMarker(ownerId, 'descending');
  }

  // 交点を、この個体について画面に出ている線の上で求め直す。折れ線が出ていれば表示中の
  // 全区間が対象で、出ていなければ解析軌道楕円 — 楕円は中心天体に固定して描かれるので、
  // 交点もその天体の慣性系で表示時刻へ写す。
  update(motion: DynamicMotion, ownerName: string, inputs: EquatorNodeInputs): void {
    const path = inputs.paths.displayedPathOf(this.ownerId);
    if (path !== null) this.solve(inputs, ownerName, path.frame, motion.state, path.samples);
    else this.solve(inputs, ownerName, null, motion.stateAt(inputs.displayTime, inputs.celestialBodies), []);
  }

  // paths(区間ごとのサンプル列、時刻昇順)が空なら state の軌道要素から求める。frame は
  // 交点位置を表示時刻へ写す座標系で、null なら中心天体の慣性系。
  private solve(
    inputs: EquatorNodeInputs, ownerName: string, frame: ReferenceFrame | null,
    state: KinematicState | null, paths: readonly (readonly KinematicState[])[],
  ): void {
    const { displayTime, celestialBodies, frameAnchors } = inputs;
    this.clearCrossings();
    if (state === null) return;
    // 中心天体は state 自身の時刻で選ぶ — 解析楕円は displayTime、折れ線は simTime の
    // 状態ベクトルから作るので、揃えないと中心の選定だけが別の瞬間のものになる。
    const centerPivot = state.t;
    const center = strongestAttractor(state.r, celestialBodies.celestialMotions, centerPivot);
    const eqNormal = center.degree2At(centerPivot)?.pole;
    if (!eqNormal) return;

    const displayFrame = frame ?? celestialBodies.frames.frameFor(center.id);
    const unbakeTf = celestialBodies.frames.transformAt(displayFrame, displayTime, frameAnchors);
    const crossings = solveEquatorCrossings(
      state, center, centerPivot, eqNormal, paths,
      (t) => celestialBodies.stateAt(center.id, t).r);
    if (!crossings) return;

    const centerName = celestialBodies.nameOf(center.id);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, celestialBodies.frames.transformAt(displayFrame, t, frameAnchors), r);

    this.ascending.place(
      toDisplay(crossings.asc.r, crossings.asc.t), crossings.asc.t, ownerName, centerName);
    this.descending.place(
      toDisplay(crossings.desc.r, crossings.desc.t), crossings.desc.t, ownerName, centerName);
  }

  // 交点を出す理由が無くなったことを記録する。
  retire(): void {
    this.ascending.retire();
    this.descending.retire();
  }

  // 交点を、求まらなかった状態にする。
  private clearCrossings(): void {
    this.ascending.place(null, null, null, null);
    this.descending.place(null, null, null, null);
  }

  // 右クリック対象として公開する EqAN/EqDN アイコン。出す理由が残っているぶんを返す。
  pickables(): readonly ObjectPickable[] {
    return [this.ascending, this.descending].filter((marker) => !marker.gone);
  }

  // 求まっている交点へ △▽ マーカーを置き、求まっていない交点は隠す。celestialBodies は
  // 遮蔽判定に使う天体で、celestialBodiesPivot はその位置を引く時刻。
  sync(
    project: ProjectFn, cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
    celestialBodiesPivot: number, occludeByBodies: boolean, timeLabel: TimeLabelSetting,
  ): void {
    for (const marker of [this.ascending, this.descending]) {
      marker.sync(
        this.markers, project, cameraPos, celestialBodies, celestialBodiesPivot,
        occludeByBodies, timeLabel,
      );
    }
  }

  // マーカー要素ごと取り除く。
  dispose(): void {
    this.retire();
    this.markers.remove(this.ascending.id);
    this.markers.remove(this.descending.id);
  }
}
