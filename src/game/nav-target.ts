// マップ上のターゲット(任意の ObjectPickable — 月・ラグランジュ点なども含む)の保持と、
// 自機軌道との相対 AN/DN(昇交点・降交点)・再接近点の算出・マーカー表示・被選択物としての公開。
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
import type { DynamicSystem } from './dynamic/dynamic-system';
import { aliveCombatTarget, combatTargetById, type CombatTarget } from './dynamic/dynamic-entity/combat-target';
import type { Notifier } from '../hud/notifier';
import { TimeLabelSetting } from './hud/orbit/calendar-ticks';
import { MarkerManager } from './marker/marker-manager';
import { RelativeNodeMarker } from './marker/relative-node-marker';
import { CameraSystem } from './camera/camera-system';
import { ObjectPickable } from './pickable/object-pickable';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { CelestialBodies } from './celestial/celestial-bodies';
import { lagrangePointOf } from './celestial/lagrange-id';
import type { OrbitReference } from './orbit-reference';

// 再接近点探索: 自艦とターゲットの相対距離を今から何秒先まで走査するか。低軌道の
// 数周ぶんに相当する1日。
const CLOSEST_APPROACH_SPAN_SEC = 86400;
const CLOSEST_APPROACH_SAMPLES = 200;
// 黄金分割探索の反復回数。固定回数にしているのは、収束判定にすると反復回数がフレームごとに
// 変動し、その分だけ結果がわずかに揺れるため。
const CLOSEST_APPROACH_REFINE_ITERATIONS = 20;

// 自艦とターゲットの相対距離が、今から CLOSEST_APPROACH_SPAN_SEC 先までのあいだで最初に
// 極小になる時刻と、その時点の自艦位置。どちらかの予測がその時刻まで届かない、または区間内に
// 極小が無ければ null(まだ近づいている途中、あるいは既に最接近を過ぎている)。
function findClosestApproach(
  controlled: DynamicEntity, target: DynamicEntity, celestialBodies: CelestialBodies, simTime: number,
): { readonly pos: Vec3; readonly t: number } | null {
  // 時刻 t の相対距離。どちらかの予測が t まで届いていなければ null。
  const distAt = (t: number): number | null => {
    const p = controlled.stateAt(t, celestialBodies);
    const q = target.stateAt(t, celestialBodies);
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
    const p = controlled.stateAt(tMin, celestialBodies);
    return p ? { pos: p.r, t: tMin } : null;
  }
  return null;
}

export class NavTarget {
  private targetId: string | null = null;
  private targetName: string | null = null;
  // 自機軌道上の AN/DN。位置は絶対座標(地球中心)で、通過時刻は自機軌道要素の現在真近点角
  // からの飛行時間を加えて求める。対象の軌道面が定まらなければどちらも解けない。
  private readonly ascendingNode = new RelativeNodeMarker('an');
  private readonly descendingNode = new RelativeNodeMarker('dn');
  // 自艦とターゲットの相対距離が最初に極小になる点。同じ中心天体を周回していない、または
  // 区間内に極小が見つからなければ解けない。
  private readonly closestApproach = new RelativeNodeMarker('ca');
  // 戦闘ビューでもターゲットの未来の軌道計算を止めないため navTargetReader を立てている個体。
  private readerEntity: DynamicEntity | null = null;

  constructor(private readonly _notifier: Notifier, private readonly markerManager: MarkerManager) {}

  // 現在のターゲットの id。未設定なら null。
  get id(): string | null {
    return this.targetId;
  }

  // 現在のターゲットの表示名。未設定なら null。
  get name(): string | null {
    return this.targetName;
  }

  // ターゲットの id と表示名を差し替える。
  private setInternal(id: string | null, name: string | null): void {
    this.targetId = id;
    this.targetName = name;
    // 対象を切り替えた時点で即座に降ろす — 次の update までターゲットが変わらない前提の
    // 個体に、外れたあとも未来予測の負担を残さない。
    this.setReaderEntity(null);
  }

  // 未来予測を依頼する個体を entity 一つに絞る。
  private setReaderEntity(entity: DynamicEntity | null): void {
    if (entity === this.readerEntity) return;
    if (this.readerEntity) this.readerEntity.navTargetReader = false;
    if (entity) entity.navTargetReader = true;
    this.readerEntity = entity;
  }

  // id と現在の設定が同じなら解除、そうでなければ id をターゲットにする。
  toggleTarget(id: string, name: string): void {
    if (this.targetId === id) {
      this.setInternal(null, null);
      this._notifier.hint('ターゲット解除');
    } else {
      this.setInternal(id, name);
      this._notifier.hint(`ターゲット: ${name}`);
    }
  }

  // Tキーなど、絶対値で敵・自艦・基地をターゲットに設定/解除する経路用。
  setCombatTarget(entity: CombatTarget | null): void {
    this.setInternal(entity?.id ?? null, entity?.name ?? null);
    this._notifier.hint(entity ? `ターゲット固定: ${entity.name}` : 'ターゲット固定解除');
  }

  // 対象消滅を伴わない一括解除(操作対象の切替など)。ヒントは出さない。
  clear(): void {
    this.setInternal(null, null);
  }

  // セーブデータからの復元用。id が敵・自機・基地を指していた場合はそれが生存していないと
  // 復元しない(撃墜・破壊されていれば未選択に戻す)。天体・ラグランジュ点など消滅しない対象は
  // 常に復元する。ヒントは出さない。
  restore(data: { id: string; name: string } | null | undefined, dynamicSystem: DynamicSystem): void {
    if (!data) return;
    const wasTarget = combatTargetById(dynamicSystem.all(), data.id);
    if (wasTarget !== null && !wasTarget.alive) return;
    this.setInternal(data.id, data.name);
  }

  // 現在のターゲットを、生存中の戦闘対象(敵・自艦・基地)として解決する。天体・ラグランジュ点
  // など戦闘対象になれない対象がターゲットの場合は null。
  resolveCombatTarget(dynamicSystem: DynamicSystem): CombatTarget | null {
    if (this.targetId === null) return null;
    return aliveCombatTarget(dynamicSystem.all(), this.targetId);
  }

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
  update(
    controlled: Controllable | null, dynamicSystem: DynamicSystem, celestialBodies: CelestialBodies, displayWindow: DisplayWindow,
    frameAnchors: FrameAnchorSource,
  ): void {
    const { simTime, displayTime, frame } = displayWindow;
    const ownerName = controlled?.name ?? null;
    for (const marker of this.nodeMarkers) marker.place(null, null, ownerName, this.name);
    // 相対交点はターゲットと操作対象の両方が揃って初めて定義できる。片方でも欠ければ
    // 出す理由そのものが無い。
    if (!this.targetId) { this.setReaderEntity(null); this.retireNodeMarkers(); return; }
    const target = aliveCombatTarget(dynamicSystem.all(), this.targetId);
    this.setReaderEntity(target);
    if (!controlled) { this.retireNodeMarkers(); return; }
    const stateCelestialBodies = celestialBodies.celestialMotions;
    const controlledCenter = strongestAttractor(controlled.state.r, stateCelestialBodies, simTime);
    const unbakeTf = celestialBodies.frames.transformAt(frame, displayTime, frameAnchors);
    // 通過時刻で焼いた点を、表示時刻の座標系へ un-bake する。
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, celestialBodies.frames.transformAt(frame, t, frameAnchors), r);

    // 再接近点は AN/DN(軌道面が定まる必要がある)とは独立した条件 — 同じ中心天体さえ
    // 周回していれば、円軌道や軌道面がほぼ一致する場合でも求まる。
    if (target && strongestAttractor(target.state.r, stateCelestialBodies, simTime).id === controlledCenter.id) {
      const found = findClosestApproach(controlled, target, celestialBodies, simTime);
      if (found) this.closestApproach.place(toDisplay(found.pos, found.t), found.t, ownerName, this.name);
    }

    const controlledEl = controlled.orbitalElementsAround(controlledCenter, simTime);
    if (!controlledEl) return;

    const targetHat = this.resolvePlaneNormal(this.targetId, dynamicSystem, celestialBodies, simTime);
    if (!targetHat) return;

    const nodes = nodeAnomalies(controlledEl, targetHat);
    if (!nodes) return;

    const tf = frameOfCelestialBody(controlledCenter, simTime);
    const nu0 = trueAnomalyAt(controlledEl, toFrameState(tf, controlled.state).r);
    const anT = simTime + tofBetween(controlledEl, nu0, nodes.asc);
    const dnT = simTime + tofBetween(controlledEl, nu0, nodes.desc);
    // 交点は中心天体基準なので、通過時刻における中心天体の精密な ECI 位置へ足す — 概算の弾道
    // pivot からの外挿だと表示側の un-bake と基準がずれ、月周回では通過までの時間ぶん位置がずれる。
    const anEci = add(celestialBodies.stateAt(controlledCenter.id, anT).r, positionOnOrbit(controlledEl, nodes.asc));
    const dnEci = add(celestialBodies.stateAt(controlledCenter.id, dnT).r, positionOnOrbit(controlledEl, nodes.desc));
    this.ascendingNode.place(toDisplay(anEci, anT), anT, ownerName, this.name);
    this.descendingNode.place(toDisplay(dnEci, dnT), dnT, ownerName, this.name);
  }

  // id がいまのターゲットなら解除する。
  clearIfTargeting(id: string): void {
    if (this.targetId === id) this.setInternal(null, null);
  }

  // 現在のターゲットの時刻 t における位置・速度。重力中心になれるのは登録天体だけで、
  // ラグランジュ点・船・基地は hasMass=false で返る。船・基地は軌道線を相対軌跡へ切り替え
  // られるよう entity 自身も添える。ターゲット未設定・解決不能なら null。
  resolveState(
    dynamicSystem: DynamicSystem, celestialBodies: CelestialBodies,
    attractors: readonly CelestialBody[], t: number,
  ): OrbitReference | null {
    const id = this.targetId;
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
    const entity = aliveCombatTarget(dynamicSystem.all(), id);
    if (!entity) return null;
    return {
      id, state: entity.stateAt(t, celestialBodies) ?? entity.state, hasMass: false,
      attractor: null, entity, fixed: true,
    };
  }

  // id がターゲットになれる(軌道面が定まる)かどうか。
  canTarget(id: string, dynamicSystem: DynamicSystem, celestialBodies: CelestialBodies, t: number): boolean {
    return this.resolvePlaneNormal(id, dynamicSystem, celestialBodies, t) !== null;
  }

  // id から対象の軌道面法線を求める。船・基地は自身の軌道要素、公転している天体(惑星・衛星)
  // はその公転面法線、ラグランジュ点(`${副天体}-l${n}`)は副天体の公転面法線を使う。
  // 面が定まらない対象(恒星、および軌道要素の無い天体・存在しない船)は null。
  private resolvePlaneNormal(id: string, dynamicSystem: DynamicSystem, celestialBodies: CelestialBodies, t: number): Vec3 | null {
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
    const entity = aliveCombatTarget(dynamicSystem.all(), id);
    if (!entity) return null;
    const center = strongestAttractor(entity.state.r, celestialBodies.celestialMotions, t);
    return entity.orbitalElementsAround(center, t)?.hHat ?? null;
  }

  // 右クリック対象として公開する AN/DN・再接近点アイコン。出す理由が残っているぶんを返す。
  pickables(): readonly ObjectPickable[] {
    return this.nodeMarkers.filter((marker) => !marker.gone);
  }

  // AN/DN・再接近点のマーカーを置く。マップビューでは天体に遮蔽された点を隠す。
  // occluders は遮蔽判定に使う天体で、occludersPivot はその位置を引く時刻。
  sync(
    cameraSystem: CameraSystem, occluders: readonly CelestialBody[],
    occludersPivot: number, timeLabel: TimeLabelSetting,
  ): void {
    for (const marker of this.nodeMarkers) {
      marker.sync(
        this.markerManager, cameraSystem.activeCameraProjection, cameraSystem.activeCameraPos,
        occluders, occludersPivot, cameraSystem.view === 'map', timeLabel,
      );
    }
  }
}
