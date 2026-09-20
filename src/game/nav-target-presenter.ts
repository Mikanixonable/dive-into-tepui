// 航法ターゲット(任意の ObjectPickable — 月・ラグランジュ点なども含む)の、位置・速度と軌道面への
// 解決と、自機軌道との相対 AN/DN(昇交点・降交点)・再接近点の算出・マーカー表示・被選択物としての公開。
import { type Vec3, add, len, sub } from '../math/vec3';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../physics/elements';
import { strongestAttractor } from '../physics/attractor';
import { OrbitingMotion } from '../physics/celestial-motion';
import { type FrameAnchorSource, frameOfCelestialBody, toFrameState, unbakeToDisplayPoint } from '../physics/frame';
import { type LagrangeLabel, lagrangeStateOf, secondaryFrameOf } from '../physics/lagrange';
import { LOCAL_FORWARD, qRotate } from '../math/quat';
import { goldenSectionMin } from '../math/optimize';
import { aliveCombatTarget } from './dynamic/dynamic-entity/combat-target';
import { RelativeNodeMarker } from './marker/relative-node-marker';
import { lagrangePointOf } from './celestial/lagrange-id';
import type { CelestialBody } from '../physics/celestial-body';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { DisplayWindow } from './display-window-manager';
import type { EntityRoster } from './dynamic/entity-roster';
import type { TimeLabelSetting } from './hud/orbit/calendar-ticks';
import type { MarkerDeclaration } from '../marker/marker-declaration';
import type { MarkerSink } from '../marker/marker-sink';
import type { MarkerDevice } from '../marker/marker-device';
import type { CameraFrame } from '../render/camera/camera-frame';
import type { ObjectPickable } from './pickable/object-pickable';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { CelestialBodies } from './celestial/celestial-bodies';
import type { OrbitReference } from './orbit-reference';
import type { NavTargetSource } from './viewer/nav-target-selection';
import type { ViewMode } from './view/view-mode';

// 再接近点探索: 自艦とターゲットの相対距離を今から何秒先まで走査するか。低軌道の
// 数周ぶんに相当する1日。
const CLOSEST_APPROACH_SPAN_SEC = 86400;
// 走査区間を等分する標本数。
const CLOSEST_APPROACH_SAMPLES = 200;
// 黄金分割探索の反復回数。収束判定にすると反復回数がフレームごとに変わり、結果が揺れる。
const CLOSEST_APPROACH_REFINE_ITERATIONS = 20;

// 自艦とターゲットの相対距離が、今から CLOSEST_APPROACH_SPAN_SEC 先までのあいだで最初に
// 極小になる時刻と、その時点の自艦位置。どちらかの予測がその時刻まで届かない、または区間内に
// 極小が無ければ null(まだ近づいている途中、あるいは既に最接近を過ぎている)。
function findClosestApproach(
  controlled: DynamicEntity, target: DynamicEntity, celestialBodies: CelestialBodies, simTime: number,
): { readonly pos: Vec3; readonly t: number } | null {
  // 時刻 t の相対距離。どちらかの予測が t まで届いていなければ null。
  const distAt = (t: number): number | null => {
    const p = controlled.motion.stateAt(t, celestialBodies);
    const q = target.motion.stateAt(t, celestialBodies);
    return p && q ? len(sub(p.r, q.r)) : null;
  };
  const step = CLOSEST_APPROACH_SPAN_SEC / CLOSEST_APPROACH_SAMPLES;
  // 隣接3点が谷型(前後より小さい)になった最初の位置を極小の挟み込み区間として使う。
  let before: number | null = null;
  let here: number | null = null;
  for (let i = 0; i <= CLOSEST_APPROACH_SAMPLES; i++) {
    const after = distAt(simTime + i * step);
    if (after === null) break;
    if (before !== null && here !== null && !(here >= before || here >= after)) {
      const lo = simTime + (i - 2) * step;
      const hi = simTime + i * step;
      const tMin = goldenSectionMin(lo, hi, (t) => distAt(t) ?? Infinity, CLOSEST_APPROACH_REFINE_ITERATIONS);
      const p = controlled.motion.stateAt(tMin, celestialBodies);
      return p ? { pos: p.r, t: tMin } : null;
    }
    before = here;
    here = after;
  }
  return null;
}

export class NavTargetPresenter {
  // 自機軌道上の相対 AN/DN。対象の軌道面が定まらなければどちらも解けない。
  private readonly ascendingNode = new RelativeNodeMarker('an');
  private readonly descendingNode = new RelativeNodeMarker('dn');
  // 自艦とターゲットの相対距離が最初に極小になる点。同じ中心天体を周回していない、または
  // 区間内に極小が見つからなければ解けない。
  private readonly closestApproach = new RelativeNodeMarker('ca');

  private readonly declarations: MarkerDeclaration[] = [];
  private readonly group: MarkerSink;

  // navTarget から航法ターゲットを読み、マーカーを markers から作ったマーカー群へ宣言する。
  public constructor(private readonly navTarget: NavTargetSource, markers: MarkerDevice) {
    this.group = markers.createGroup();
  }

  // 所有するマーカー群を取り除く。
  public dispose(): void { this.group.dispose(); }

  // AN・DN・再接近点のマーカー。
  private get nodeMarkers(): readonly RelativeNodeMarker[] {
    return [this.ascendingNode, this.descendingNode, this.closestApproach];
  }

  // 相対交点を出す理由が無くなったことを、3つのマーカーへ記録する。
  private retireNodeMarkers(): void {
    for (const marker of this.nodeMarkers) marker.retire();
  }

  // 相対 AN/DN・再接近点の位置と通過時刻を求め直す。解けない点は解けていない状態にし、
  // ターゲットか操作対象が欠ければ3点とも出す理由が無くなったものとする。
  public update(
    controlled: Controllable | null, roster: EntityRoster, celestialBodies: CelestialBodies, displayWindow: DisplayWindow,
    frameAnchors: FrameAnchorSource,
  ): void {
    const { simTime, displayTime, frame } = displayWindow;
    const { id: targetId, name: targetName } = this.navTarget;
    const ownerName = controlled?.name ?? null;
    for (const marker of this.nodeMarkers) marker.place(null, null, ownerName, targetName);
    if (!targetId) { this.retireNodeMarkers(); return; }
    if (!controlled) { this.retireNodeMarkers(); return; }
    const target = aliveCombatTarget(roster.all(), targetId);
    const stateCelestialBodies = celestialBodies.celestialMotions;
    const controlledCenter = strongestAttractor(
      controlled.motion.state.r, stateCelestialBodies, simTime,
    );
    const unbakeTf = celestialBodies.frames.transformAt(frame, displayTime, frameAnchors);
    // 通過時刻で焼いた点を、表示時刻の座標系へ un-bake する。
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, celestialBodies.frames.transformAt(frame, t, frameAnchors), r);

    // 再接近点は軌道面が定まらなくても解けるので、AN/DN の早期 return より前に求める。
    if (target && strongestAttractor(
      target.motion.state.r, stateCelestialBodies, simTime,
    ).id === controlledCenter.id) {
      const found = findClosestApproach(controlled, target, celestialBodies, simTime);
      if (found) this.closestApproach.place(toDisplay(found.pos, found.t), found.t, ownerName, targetName);
    }

    const controlledEl = controlled.motion.orbitalElementsAround(controlledCenter, simTime);
    if (!controlledEl) return;

    const targetHat = this.resolvePlaneNormal(targetId, roster, celestialBodies, simTime);
    if (!targetHat) return;

    const nodes = nodeAnomalies(controlledEl, targetHat);
    if (!nodes) return;

    const tf = frameOfCelestialBody(controlledCenter, simTime);
    const nu0 = trueAnomalyAt(controlledEl, toFrameState(tf, controlled.motion.state).r);
    const anT = simTime + tofBetween(controlledEl, nu0, nodes.asc);
    const dnT = simTime + tofBetween(controlledEl, nu0, nodes.desc);
    // 交点は中心天体基準なので、通過時刻における中心天体の精密な ECI 位置へ足す — 概算の弾道
    // pivot からの外挿だと表示側の un-bake と基準がずれ、月周回では通過までの時間ぶん位置がずれる。
    const anEci = add(celestialBodies.stateAt(controlledCenter.id, anT).r, positionOnOrbit(controlledEl, nodes.asc));
    const dnEci = add(celestialBodies.stateAt(controlledCenter.id, dnT).r, positionOnOrbit(controlledEl, nodes.desc));
    this.ascendingNode.place(toDisplay(anEci, anT), anT, ownerName, targetName);
    this.descendingNode.place(toDisplay(dnEci, dnT), dnT, ownerName, targetName);
  }

  // 現在のターゲットの時刻 t における位置・速度。質量を持つのは登録天体だけで、船・基地には
  // entity も添える。ターゲット未設定・解決不能なら null。
  public resolveState(
    roster: EntityRoster, celestialBodies: CelestialBodies,
    attractors: readonly CelestialBody[], t: number,
  ): OrbitReference | null {
    const id = this.navTarget.id;
    if (id === null) return null;
    // 登録天体なら、その運動から直接引く。
    const attractor = celestialBodies.findMotion(id);
    if (attractor instanceof OrbitingMotion) {
      return { id, state: attractor.stateAt(t), hasMass: true, attractor, entity: null, fixed: true };
    }
    // ラグランジュ点は副天体の回転座標系から計算する。
    const lagrange = lagrangePointOf(id);
    if (lagrange !== null) {
      const secondary = celestialBodies.findMotion(lagrange.parentId) ?? null;
      const frame = secondary instanceof OrbitingMotion
        ? secondaryFrameOf(attractors, t, secondary, t) : null;
      if (frame !== null) {
        const point = `L${lagrange.point}` as LagrangeLabel;
        return {
          id, state: lagrangeStateOf(point, frame), hasMass: false,
          attractor: null, entity: null, fixed: true,
        };
      }
    }
    // 残りは生存中の艦・基地。
    const entity = aliveCombatTarget(roster.all(), id);
    if (!entity) return null;
    return {
      id, state: entity.motion.stateAt(t, celestialBodies) ?? entity.motion.state, hasMass: false,
      attractor: null, entity, fixed: true,
    };
  }

  // id がターゲットになれる(軌道面が定まる)かどうか。
  public canTarget(id: string, roster: EntityRoster, celestialBodies: CelestialBodies, t: number): boolean {
    return this.resolvePlaneNormal(id, roster, celestialBodies, t) !== null;
  }

  // id の軌道面法線。公転天体は公転面、ラグランジュ点は副天体の公転面、船・基地は自身の軌道の
  // 法線を使う。面が定まらない対象(恒星・軌道要素の無いもの・存在しない船)は null。
  private resolvePlaneNormal(id: string, roster: EntityRoster, celestialBodies: CelestialBodies, t: number): Vec3 | null {
    const idMotion = celestialBodies.findMotion(id);
    if (idMotion instanceof OrbitingMotion) {
      return idMotion.orbitNormalAt(t);
    }
    // 同じ形の id を持つ船と取り違えないよう、副天体が実在する公転天体のときだけラグランジュ点とみなす。
    const lagrange = lagrangePointOf(id);
    const secondaryMotion = lagrange === null ? undefined : celestialBodies.findMotion(lagrange.parentId);
    if (secondaryMotion instanceof OrbitingMotion) {
      return qRotate(secondaryMotion.orbitFrameRotationAt(t).q, LOCAL_FORWARD);
    }
    const entity = aliveCombatTarget(roster.all(), id);
    if (!entity) return null;
    const center = strongestAttractor(entity.motion.state.r, celestialBodies.celestialMotions, t);
    return entity.motion.orbitalElementsAround(center, t)?.hHat ?? null;
  }

  // 右クリック対象として公開する AN/DN・再接近点アイコン。出す理由が残っているぶんを返す。
  public pickables(): readonly ObjectPickable[] {
    return this.nodeMarkers.filter((marker) => !marker.gone);
  }

  // AN/DN・再接近点のマーカーを update で求めた位置へ、マップビューでだけ置く。天体に遮蔽された点は
  // 隠す。occluders は遮蔽判定に使う天体で、occludersPivot はその位置を引く時刻。
  public sync(
    camera: CameraFrame, view: ViewMode, occluders: readonly CelestialBody[],
    occludersPivot: number, timeLabel: TimeLabelSetting, nowMs: number,
  ): void {
    const declarations = this.declarations;
    declarations.length = 0;
    // 戦闘ビューでは空の宣言で3点とも片付ける。
    if (view === 'map') {
      for (const marker of this.nodeMarkers) {
        declarations.push(marker.declaration(
          camera.project, camera.position, occluders, occludersPivot, true, timeLabel,
        ));
      }
    }
    this.group.sync(declarations, nowMs);
  }
}
