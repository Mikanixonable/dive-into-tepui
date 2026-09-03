// マップ上のターゲット(任意の ObjectPickable — 月・ラグランジュ点なども含む)の保持と、
// 自機軌道との相対 AN/DN(昇交点・降交点)・再接近点の算出・マーカー表示・被選択物としての公開。
// ターゲットが敵・自艦・基地(CombatTarget)の場合は、Targeter の射撃・照準補助の基準にもなる。
import { Vec3, add, len, sub } from '../math/vec3';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../physics/elements';
import { strongestAttractor } from '../physics/attractor';
import { CelestialMotion } from '../physics/celestial-motion';
import { frameOfCelestialBody } from '../physics/frame';
import { LagrangeLabel, lagrangeStateOf, secondaryFrameOf } from '../physics/lagrange';
import { FrameAnchorSource, toFrameState, unbakeToDisplayPoint } from '../physics/frame';
import { OrbitingMotion } from '../physics/celestial-motion';
import { LOCAL_FORWARD, qRotate } from '../math/quat';
import { goldenSectionMin } from '../math/optimize';
import { Player } from './player/player';
import { DisplayWindow, timeLabelSettingOf } from './display-window-manager';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { CombatTarget } from './targeter';
import { Hud } from './hud/hud';
import { TimeLabelSetting } from './hud/orbit/calendar-ticks';
import { MarkerManager } from './marker/marker-manager';
import { RelativeNodeMarker } from './marker/relative-node-marker';
import { CameraSystem } from './camera/camera-system';
import { ObjectPickable } from './pickable/object-pickable';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { CelestialSystem } from './celestial/celestial-system';
import { lagrangePointOf } from './celestial/lagrange-id';
import type { OrbitReference } from './orbit-reference';

// 再接近点探索: 自艦とターゲットの相対距離を今から何秒先まで走査するか。低軌道の
// 数周ぶんに相当する1日。
const CLOSEST_APPROACH_SPAN_SEC = 86400;
const CLOSEST_APPROACH_SAMPLES = 200;
// 黄金分割探索の反復回数。固定回数にしているのは、収束判定にすると反復回数がフレームごとに
// 変動し、その分だけ結果がわずかに揺れるため(trajectory-features.ts の REFINE_ITERATIONS と同じ理由)。
const CLOSEST_APPROACH_REFINE_ITERATIONS = 20;

// 自艦とターゲットの相対距離が、今から CLOSEST_APPROACH_SPAN_SEC 先までのあいだで最初に
// 極小になる時刻と、その時点の自艦位置。粗いサンプル列で極小を挟む区間を見つけ、黄金分割
// 探索で追い込む。どちらかの予測がその時刻まで届かない、または区間内に極小が無ければ null
// (まだ近づいている途中、あるいは既に最接近を過ぎている)。
function findClosestApproach(
  player: DynamicEntity, target: DynamicEntity, celestialSystem: CelestialSystem, simTime: number,
): { readonly pos: Vec3; readonly t: number } | null {
  const distAt = (t: number): number | null => {
    const p = player.stateAt(t, celestialSystem);
    const q = target.stateAt(t, celestialSystem);
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
    const p = player.stateAt(tMin, celestialSystem);
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
  // update が求めた時点の CelestialMotion[]。sync でのマップビュー遮蔽判定に使う。
  private celestialBodies: readonly CelestialMotion[] = [];
  // celestialBodies の位置を厳密に引く時刻。
  private celestialBodiesPivot = 0;
  // 通過時刻ラベルの設定。update ごとに表示窓から組み直し、sync のラベル組み立てで読む。
  private timeLabel: TimeLabelSetting = {
    mode: 'absolute', show: false, nowSimTime: 0, epochUnixSec: 0,
  };
  // 戦闘ビューでもターゲットの未来の軌道計算を止めないため navTargetReader を立てている個体。
  private readerEntity: DynamicEntity | null = null;

  constructor(private readonly _hud: Hud, private readonly markerManager: MarkerManager) {}

  get id(): string | null {
    return this.targetId;
  }

  get name(): string | null {
    return this.targetName;
  }

  private setInternal(id: string | null, name: string | null): void {
    this.targetId = id;
    this.targetName = name;
    // 対象を切り替えた時点で即座に降ろす — 次の update までターゲットが変わらない前提の
    // 個体に、外れたあとも未来予測の負担を残さない。
    this.setReaderEntity(null);
  }

  // 旧対象のフラグを降ろし、新対象に立て直す。
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
      this._hud.hint('ターゲット解除');
    } else {
      this.setInternal(id, name);
      this._hud.hint(`ターゲット: ${name}`);
    }
  }

  // Tキーなど、絶対値で敵・自艦・基地をターゲットに設定/解除する経路用。
  setCombatTarget(entity: CombatTarget | null): void {
    this.setInternal(entity?.id ?? null, entity?.name ?? null);
    this._hud.hint(entity ? `ターゲット固定: ${entity.name}` : 'ターゲット固定解除');
  }

  // 対象消滅を伴わない一括解除(操作対象艦の切替など)。ヒントは出さない。
  clear(): void {
    this.setInternal(null, null);
  }

  // セーブデータからの復元用。id が敵・自機・基地を指していた場合はそれが生存していないと
  // 復元しない(撃墜・破壊されていれば未選択に戻す)。天体・ラグランジュ点など消滅しない対象は
  // 常に復元する。ヒントは出さない。
  restore(data: { id: string; name: string } | null | undefined, entities: DynamicSystem): void {
    if (!data) return;
    const wasEntityId = entities.findEnemy(data.id) !== null
      || entities.players.some((p) => p.id === data.id)
      || entities.bases.some((b) => b.id === data.id);
    if (wasEntityId && !entities.findAliveCombatTarget(data.id)) return;
    this.setInternal(data.id, data.name);
  }

  // 現在のターゲットを、生存中の戦闘対象(敵・自艦・基地)として解決する。天体・ラグランジュ点
  // など戦闘対象になれない対象がターゲットの場合は null。
  resolveCombatTarget(entities: DynamicSystem): CombatTarget | null {
    if (this.targetId === null) return null;
    const entity = entities.findAliveCombatTarget(this.targetId);
    return entity && entity.alive ? entity : null;
  }

  private get nodeMarkers(): readonly RelativeNodeMarker[] {
    return [this.ascendingNode, this.descendingNode, this.closestApproach];
  }

  // 自機軌道要素と対象の軌道面法線から相対 AN/DN の位置・通過時刻を求め直す。
  // 対象の軌道面が定まらない(地球・太陽自身など)場合や自機軌道要素が無い場合は、
  // どちらの交点も解けていない状態にする。
  // positionOnOrbit は中心天体基準の相対位置を返すので、CelestialMotion.stateAt で通過時刻
  // anT/dnT における中心天体の精密な ECI 位置を求めて足し合わせ、絶対位置に直す — 概算の弾道
  // pivot からの外挿を使うと、表示側が数値暦で un-bake するのと基準がずれて、
  // 月周回では通過までの時間ぶん位置がずれる。位置は通過時刻で bake し、displayWindow の
  // 表示時刻で un-bake して描画座標系へ移す。
  update(
    player: Player | null, entities: DynamicSystem, celestialSystem: CelestialSystem, displayWindow: DisplayWindow,
    frameAnchors: FrameAnchorSource,
  ): void {
    const { simTime, displayTime, frame } = displayWindow;
    const ownerName = player?.name ?? null;
    for (const marker of this.nodeMarkers) marker.place(null, null, ownerName, this.name);
    this.timeLabel = timeLabelSettingOf(displayWindow);
    this.celestialBodies = frameAnchors.bodies;
    this.celestialBodiesPivot = frameAnchors.bodiesPivot;
    if (!this.targetId) { this.setReaderEntity(null); return; }
    // ターゲット自身の赤道交点は、自機の軌道要素が求まるかどうかとは無関係に出す。
    const target = entities.findAliveCombatTarget(this.targetId);
    this.setReaderEntity(target);
    target?.ensureEquatorNodes(this.markerManager)
      .updateOnEllipse(displayTime, celestialSystem, frameAnchors, this.timeLabel);
    if (!player) return;
    const stateCelestialBodies = celestialSystem.celestialMotions;
    const playerCenter = strongestAttractor(player.state.r, stateCelestialBodies, simTime);
    const unbakeTf = celestialSystem.frames.transformAt(frame, displayTime, frameAnchors);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, celestialSystem.frames.transformAt(frame, t, frameAnchors), r);

    // 再接近点は AN/DN(軌道面が定まる必要がある)とは独立した条件 — 同じ中心天体さえ
    // 周回していれば、円軌道や軌道面がほぼ一致する場合でも求まる。
    if (target && strongestAttractor(target.state.r, stateCelestialBodies, simTime).id === playerCenter.id) {
      const found = findClosestApproach(player, target, celestialSystem, simTime);
      if (found) this.closestApproach.place(toDisplay(found.pos, found.t), found.t, ownerName, this.name);
    }

    const playerEl = player.orbitalElementsAround(playerCenter, simTime);
    if (!playerEl) return;

    const targetHat = this.resolvePlaneNormal(this.targetId, entities, celestialSystem, simTime);
    if (!targetHat) return;

    const nodes = nodeAnomalies(playerEl, targetHat);
    if (!nodes) return;

    const tf = frameOfCelestialBody(playerCenter, simTime);
    const nu0 = trueAnomalyAt(playerEl, toFrameState(tf, player.state).r);
    const anT = simTime + tofBetween(playerEl, nu0, nodes.asc);
    const dnT = simTime + tofBetween(playerEl, nu0, nodes.desc);
    const anEci = add(celestialSystem.stateAt(playerCenter.id, anT).r, positionOnOrbit(playerEl, nodes.asc));
    const dnEci = add(celestialSystem.stateAt(playerCenter.id, dnT).r, positionOnOrbit(playerEl, nodes.desc));
    this.ascendingNode.place(toDisplay(anEci, anT), anT, ownerName, this.name);
    this.descendingNode.place(toDisplay(dnEci, dnT), dnT, ownerName, this.name);
  }

  clearIfTargeting(id: string): void {
    if (this.targetId === id) this.setInternal(null, null);
  }

  // 現在のターゲットの時刻 t における位置・速度。重力中心になれるのは登録天体だけで、
  // ラグランジュ点・船・基地は hasMass=false で返る。船・基地は軌道線を相対軌跡へ切り替え
  // られるよう entity 自身も添える。ターゲット未設定・解決不能なら null。
  resolveState(
    entities: DynamicSystem, celestialSystem: CelestialSystem,
    celestialBodies: readonly CelestialMotion[], t: number,
  ): OrbitReference | null {
    const id = this.targetId;
    if (id === null) return null;
    const attractor = celestialSystem.find(id)?.motion;
    if (attractor instanceof OrbitingMotion) {
      return { id, state: attractor.stateAt(t), hasMass: true, attractor, entity: null, fixed: true };
    }
    const lagrange = lagrangePointOf(id);
    if (lagrange !== null) {
      const secondary = celestialSystem.find(lagrange.parentId)?.motion ?? null;
      const frame = secondary instanceof OrbitingMotion
        ? secondaryFrameOf(celestialBodies, t, secondary, t) : null;
      if (frame !== null) {
        const point = `L${lagrange.point}` as LagrangeLabel;
        return {
          id, state: lagrangeStateOf(point, frame), hasMass: false,
          attractor: null, entity: null, fixed: true,
        };
      }
    }
    const entity = entities.findAliveCombatTarget(id);
    if (!entity) return null;
    return {
      id, state: entity.stateAt(t, celestialSystem) ?? entity.state, hasMass: false,
      attractor: null, entity, fixed: true,
    };
  }

  // id がターゲットになれる(軌道面が定まる)かどうか。
  canTarget(id: string, entities: DynamicSystem, celestialSystem: CelestialSystem, t: number): boolean {
    return this.resolvePlaneNormal(id, entities, celestialSystem, t) !== null;
  }

  // id から対象の軌道面法線を求める。船・基地は自身の軌道要素、公転している天体(惑星・衛星)
  // はその公転面法線、ラグランジュ点(`${副天体}-l${n}`)は副天体の公転面法線を使う。
  // 面が定まらない対象(恒星、および軌道要素の無い天体・存在しない船)は null。
  private resolvePlaneNormal(id: string, entities: DynamicSystem, celestialSystem: CelestialSystem, t: number): Vec3 | null {
    const idMotion = celestialSystem.find(id)?.motion;
    if (idMotion instanceof OrbitingMotion) {
      return idMotion.orbitNormalAt(t);
    }
    // 副天体がレジストリに実在する公転天体のときだけラグランジュ点として解釈する。そうしないと
    // 同じ形の名前を持つ船が天体として誤って解決される。
    const lagrange = lagrangePointOf(id);
    const secondaryMotion = lagrange === null ? undefined : celestialSystem.find(lagrange.parentId)?.motion;
    if (secondaryMotion instanceof OrbitingMotion) {
      return qRotate(secondaryMotion.orbitFrameRotationAt(t).q, LOCAL_FORWARD);
    }
    const entity = entities.findAliveCombatTarget(id);
    if (!entity) return null;
    const center = strongestAttractor(entity.state.r, celestialSystem.celestialMotions, t);
    return entity.orbitalElementsAround(center, t)?.hHat ?? null;
  }

  // 右クリック対象として公開する AN/DN・再接近点アイコン。計算できているぶんだけ返す。
  pickables(): readonly ObjectPickable[] {
    return this.nodeMarkers.filter((marker) => !marker.gone);
  }

  // マップビューでは、天体に遮蔽されて画面上見えていない AN/DN・再接近点を隠す(戦闘ビューでは効かせない)。
  sync(cameraSystem: CameraSystem): void {
    for (const marker of this.nodeMarkers) {
      marker.sync(
        this.markerManager, cameraSystem.activeCameraProjection, cameraSystem.activeCameraPos,
        this.celestialBodies, this.celestialBodiesPivot, cameraSystem.view === 'map', this.timeLabel,
      );
    }
  }
}
