// 航法ターゲット(任意の ObjectPickable — 月・ラグランジュ点なども含む)の、位置・速度と軌道面への
// 解決と、自機軌道との相対 AN/DN(昇交点・降交点)・再接近点の算出・マーカー表示・被選択物としての公開。
import { Vec3, add, len, sub } from '../math/vec3';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../physics/elements';
import { strongestAttractor } from '../physics/attractor';
import { OrbitingMotion } from '../physics/celestial-motion';
import type { CelestialBody } from '../physics/celestial-body';
import { FrameAnchorSource, frameOfCelestialBody, toFrameState, unbakeToDisplayPoint } from '../physics/frame';
import { LagrangeLabel, lagrangeStateOf, secondaryFrameOf } from '../physics/lagrange';
import { LOCAL_FORWARD, qRotate } from '../math/quat';
import { goldenSectionMin } from '../math/optimize';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { DisplayWindow } from './display-window-manager';
import type { EntityRoster } from './dynamic/entity-roster';
import { aliveCombatTarget } from './dynamic/dynamic-entity/combat-target';
import { TimeLabelSetting } from './hud/orbit/calendar-ticks';
import type { MarkerDeclaration } from '../marker/marker-declaration';
import type { MarkerSink } from '../marker/marker-sink';
import { RelativeNodeMarker } from './marker/relative-node-marker';
import type { CameraFrame } from '../render/camera/camera-frame';
import { ObjectPickable } from './pickable/object-pickable';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { CelestialBodies } from './celestial/celestial-bodies';
import { lagrangePointOf } from './celestial/lagrange-id';
import type { OrbitReference } from './orbit-reference';
import type { NavTargetSource } from './viewer/nav-target-selection';

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
  const samples: number[] = [];
  for (let i = 0; i <= CLOSEST_APPROACH_SAMPLES; i++) {
    const d = distAt(simTime + i * step);
    if (d === null) break;
    samples.push(d);
  }
  // 隣接3点が谷型(前後より小さい)になった最初の位置を極小の挟み込み区間として使う。
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i]! >= samples[i - 1]! || samples[i]! >= samples[i + 1]!) continue;
    const lo = simTime + (i - 1) * step;
    const hi = simTime + (i + 1) * step;
    const tMin = goldenSectionMin(lo, hi, (t) => distAt(t) ?? Infinity, CLOSEST_APPROACH_REFINE_ITERATIONS);
    const p = controlled.motion.stateAt(tMin, celestialBodies);
    return p ? { pos: p.r, t: tMin } : null;
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

  // navTarget から航法ターゲットを読み、マーカーを group へ宣言する。
  public constructor(private readonly navTarget: NavTargetSource, private readonly group: MarkerSink) {}

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

  // 自機軌道要素と対象の軌道面法線から相対 AN/DN の位置・通過時刻を求め直す。
  // 対象の軌道面が定まらない(地球・太陽自身など)場合や操作対象の軌道要素が無い場合は、
  // どちらの交点も解けていない状態にする。
  public update(
    controlled: Controllable | null, roster: EntityRoster, celestialBodies: CelestialBodies, displayWindow: DisplayWindow,
    frameAnchors: FrameAnchorSource,
  ): void {
    const { simTime, displayTime, frame } = displayWindow;
    const { id: targetId, name: targetName } = this.navTarget;
    const ownerName = controlled?.name ?? null;
    for (const marker of this.nodeMarkers) marker.place(null, null, ownerName, targetName);
    // 相対交点はターゲットと操作対象の両方が揃って初めて定義できる。片方でも欠ければ
    // 出す理由そのものが無い。
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

    // 再接近点は AN/DN(軌道面が定まる必要がある)とは独立した条件 — 同じ中心天体さえ
    // 周回していれば、円軌道や軌道面がほぼ一致する場合でも求まる。
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

  // 現在のターゲットの時刻 t における位置・速度。重力中心になれるのは登録天体だけで、
  // ラグランジュ点・船・基地は hasMass=false で返る。船・基地は軌道線を相対軌跡へ切り替え
  // られるよう entity 自身も添える。ターゲット未設定・解決不能なら null。
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
    // ラグランジュ点は副天体の回転系から解く。
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

  // id から対象の軌道面法線を求める。船・基地は自身の軌道要素、公転している天体(惑星・衛星)
  // はその公転面法線、ラグランジュ点(`${副天体}-l${n}`)は副天体の公転面法線を使う。
  // 面が定まらない対象(恒星、および軌道要素の無い天体・存在しない船)は null。
  private resolvePlaneNormal(id: string, roster: EntityRoster, celestialBodies: CelestialBodies, t: number): Vec3 | null {
    const idMotion = celestialBodies.findMotion(id);
    if (idMotion instanceof OrbitingMotion) {
      return idMotion.orbitNormalAt(t);
    }
    // 副天体がレジストリに実在する公転天体のときだけラグランジュ点として解釈する。そうしないと
    // 同じ形の名前を持つ船が天体として誤って解決される。
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

  // AN/DN・再接近点のマーカーを置く。マップビューでは天体に遮蔽された点を隠す。
  // occluders は遮蔽判定に使う天体で、occludersPivot はその位置を引く時刻。
  public sync(
    camera: CameraFrame, occluders: readonly CelestialBody[],
    occludersPivot: number, timeLabel: TimeLabelSetting, nowMs: number,
  ): void {
    const declarations = this.declarations;
    declarations.length = 0;
    for (const marker of this.nodeMarkers) {
      declarations.push(marker.declaration(
        camera.project, camera.position,
        occluders, occludersPivot, camera.mode === 'map', timeLabel,
      ));
    }
    this.group.sync(declarations, nowMs);
  }
}
