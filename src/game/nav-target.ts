// マップ上の航法ターゲット(任意の MapPickable)の保持と、自機軌道との相対 AN/DN(昇交点・
// 降交点)の算出・マーカー表示・被選択物としての公開。Targeter の戦闘ターゲット(Enemy 専用)
// とは独立に、月・ラグランジュ点なども対象にできる。
import { Vec3, v3, add } from '../physics/vec3';
import { KinematicState } from '../physics/kinematic-state';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../physics/elements';
import { CelestialBody, OrbitingId, frameOfCelestialBody, strongestAttractor } from '../physics/celestial-body';
import type { LagrangePoints } from '../physics/lagrange';
import { toFrameState, unbakeToDisplayPoint } from '../physics/frame';
import { bodyDef } from '../physics/solar-system';
import type { Ephemeris } from '../physics/ephemeris';
import { qRotate } from '../physics/attitude';
import { Player } from './player/player';
import type { DisplayWindow } from './display-window-manager';
import type { EntityManager } from './simulation/entity-manager';
import type { CombatTarget } from './targeter';
import { Hud } from './hud/hud';
import { MarkerManager } from './marker/marker-manager';
import { ORBIT_POINT_GLYPH } from './marker/marker-glyphs';
import { CameraSystem } from './camera/camera-system';
import type { ProjectFn } from './camera/camera-system';
import { MapPickable } from './map-pickable';
import { pickNearest } from './map-pickable';
import type { Base } from './game-entity/base';
import type { Input } from './input/input';
import { pickRadiusSq } from './input/pointer-precision';
import * as C from './const';
import { ContextMenu } from './hud/context-menu';
import { MenuAction, MenuCommon } from './hud/menu-actions';

const Z_HAT: Vec3 = v3(0, 0, 1);

export class NavTarget {
  private readonly baseMenu: ContextMenu<Base, MenuAction>;
  private targetId: string | null = null;
  private targetName: string | null = null;
  private ownerName: string | null = null;
  // 自機軌道上の AN/DN の絶対位置(地球中心)。対象の軌道面が定まらなければ両方 null。
  private anPos: Vec3 | null = null;
  private dnPos: Vec3 | null = null;
  // AN/DN 通過の絶対時刻 [s]。自機軌道要素の現在真近点角からの飛行時間を加えて求める。
  private anTime: number | null = null;
  private dnTime: number | null = null;
  // update が求めた時点の CelestialBody[]。sync でのマップビュー遮蔽判定に使う。
  private celestialBodies: readonly CelestialBody[] = [];
  private readonly pickableCache: MapPickable[] = [];

  constructor(private readonly _hud: Hud, private readonly markerManager: MarkerManager) {
    this.baseMenu = new ContextMenu<Base, MenuAction>(_hud.layers.popup, _hud.overlayManager);
    this.baseMenu.onSelect = (act, base) => {
      if (act === 'navTarget') this.toggleTarget(base.id, '基地');
    };
  }

  get id(): string | null {
    return this.targetId;
  }

  get name(): string | null {
    return this.targetName;
  }

  private setInternal(id: string | null, name: string | null): void {
    this.targetId = id;
    this.targetName = name;
  }

  // id と現在の設定が同じなら解除、そうでなければ id を航法ターゲットにする。
  toggleTarget(id: string, name: string): void {
    if (this.targetId === id) {
      this.setInternal(null, null);
      this._hud.hint('航法ターゲット解除');
    } else {
      this.setInternal(id, name);
      this._hud.hint(`航法ターゲット: ${name}`);
    }
  }

  // Tキーなど、絶対値で戦闘ターゲット(敵・自艦・基地)を設定/解除する経路用。
  // 戦闘ターゲットは航法ターゲットと状態を共有するため、ここが両者の唯一の書き込み口になる。
  setCombatTarget(entity: CombatTarget | null): void {
    this.setInternal(entity?.id ?? null, entity?.name ?? null);
    this._hud.hint(entity ? `ターゲット固定: ${entity.name}` : 'ターゲット固定解除');
  }

  // 右クリックのプロパティウィンドウの「ターゲット」項目用。現在の設定と同じ対象ならその場で解除する。
  toggleCombatTarget(entity: CombatTarget): void {
    this.setCombatTarget(this.targetId === entity.id ? null : entity);
  }

  // 対象消滅を伴わない一括解除(操作対象艦の切替など)。ヒントは出さない。
  clear(): void {
    this.setInternal(null, null);
  }

  // 現在の航法ターゲットを、生存中の戦闘対象(敵・自艦・基地)として解決する。天体・ラグランジュ点
  // など戦闘対象になれない航法ターゲットは null。
  resolveCombatTarget(entities: EntityManager): CombatTarget | null {
    if (this.targetId === null) return null;
    const entity = this.resolveEntity(this.targetId, entities);
    return entity && entity.alive ? entity : null;
  }

  // AN/DN の通過時刻 [s]。id は 'nav-an'/'nav-dn'。未計算・対象外なら null。
  passTimeOf(id: string): number | null {
    if (id === 'nav-an') return this.anTime;
    if (id === 'nav-dn') return this.dnTime;
    return null;
  }

  // 自機軌道要素と対象の軌道面法線から相対 AN/DN の位置・通過時刻を求め直す。
  // 対象の軌道面が定まらない(地球・太陽自身など)場合や自機軌道要素が無い場合は両方 null にする。
  // positionOnOrbit は中心天体基準の相対位置を返すので、ephemeris.positionOf で通過時刻
  // anT/dnT における中心天体の精密な ECI 位置を求めて足し合わせ、絶対位置に直す — 概算の弾道
  // 外挿(celestialBodyPositionAt)を使うと、表示側が精密暦で un-bake するのと基準がずれて、
  // 月周回では通過までの時間ぶん位置がずれる。位置は通過時刻で bake し、displayWindow の
  // 表示時刻で un-bake して描画座標系へ移す。
  update(
    player: Player | null, entities: EntityManager, ephemeris: Ephemeris, displayWindow: DisplayWindow,
  ): void {
    const { simTime, displayTime, frame } = displayWindow;
    this.anPos = this.dnPos = this.anTime = this.dnTime = null;
    this.ownerName = player?.name ?? null;
    this.celestialBodies = ephemeris.celestialBodiesAt(displayTime);
    if (!this.targetId) return;
    // 航法ターゲット自身の赤道交点は、自機の軌道要素が求まるかどうかとは無関係に出す。
    const target = this.resolveEntity(this.targetId, entities);
    target?.ensureEquatorNodes(this.markerManager).update(frame, displayTime, ephemeris);
    if (!player) return;
    const stateCelestialBodies = ephemeris.celestialBodiesAt(simTime);
    const playerCenter = strongestAttractor(player.state.r, stateCelestialBodies);
    const playerEl = player.orbitalElementsAround(playerCenter);
    if (!playerEl) return;

    const targetHat = this.resolvePlaneNormal(this.targetId, entities, ephemeris, simTime);
    if (!targetHat) return;

    const nodes = nodeAnomalies(playerEl, targetHat);
    if (!nodes) return;

    const tf = frameOfCelestialBody(playerCenter);
    const nu0 = trueAnomalyAt(playerEl, toFrameState(tf, player.state).r);
    const anT = simTime + tofBetween(playerEl, nu0, nodes.asc);
    const dnT = simTime + tofBetween(playerEl, nu0, nodes.desc);
    const anEci = add(ephemeris.positionOf(playerCenter.id, anT), positionOnOrbit(playerEl, nodes.asc));
    const dnEci = add(ephemeris.positionOf(playerCenter.id, dnT), positionOnOrbit(playerEl, nodes.desc));
    const unbakeTf = ephemeris.frameTransformAt(frame, displayTime, this.celestialBodies);
    const toDisplay = (r: Vec3, t: number): Vec3 =>
      unbakeToDisplayPoint(unbakeTf, ephemeris.frameTransformAt(frame, t, this.celestialBodies), r);
    this.anPos = toDisplay(anEci, anT);
    this.dnPos = toDisplay(dnEci, dnT);
    this.anTime = anT;
    this.dnTime = dnT;
  }

  clearIfTargeting(id: string): void {
    if (this.targetId === id) this.targetId = null;
  }

  // 基地用コンテキストメニューを片付ける。
  dispose(): void {
    this.baseMenu.dispose();
  }

  // 戦闘ビューの右クリックで基地を航法ターゲットに設定/解除する。基地に当たらなければ
  // クリックを消費せず、Targeter の敵ターゲット選択へフォールスルーさせる。ビューはここでは
  // 持たないので毎フレーム引数で受け取り、マップ視点では何もしない。
  handleCombatBaseClick(entities: EntityManager, input: Input, project: ProjectFn, overviewMode: boolean): void {
    if (overviewMode) return;
    input.takeRightClicks((click) => {
      const pickables = entities.bases.filter((b) => b.alive).map((base) => ({ pos: base.state.r, base }));
      // pointer:coarse では許容半径を広げる。
      const picked = pickNearest(
        pickables, click.x, click.y, project, pickRadiusSq(C.TARGET_LOCK_PICK_PX_SQ, C.TARGET_LOCK_PICK_PX_SQ_COARSE),
      );
      if (!picked) return false;
      this.baseMenu.open(click.x, click.y, picked.base, [
        MenuCommon.navTarget(this.targetId === picked.base.id),
        MenuCommon.cancel(),
      ]);
      return true;
    });
  }

  // 現在の航法ターゲットの位置・速度。天体は CelestialBody.state、ラグランジュ点は
  // ephemeris.lagrangeStateAt、船・基地は entity.state から得る。天体以外は重力中心ではない
  // ため hasMass=false を返す。ターゲット未設定・解決不能なら null。
  resolveState(
    entities: EntityManager, ephemeris: Ephemeris, celestialBodies: readonly CelestialBody[], t: number,
  ): { id: string; state: KinematicState; hasMass: boolean; attractor: CelestialBody | null } | null {
    const id = this.targetId;
    if (id === null) return null;
    const registry = ephemeris.registry;
    if (id in registry && bodyDef(registry, id).kind !== 'star') {
      const attractor = celestialBodies.find((a) => a.id === id);
      if (attractor) return { id, state: attractor.state, hasMass: true, attractor };
    }
    const match = /^(.+)-l([1-5])$/.exec(id);
    if (match) {
      const secondary = match[1]!;
      if (secondary in registry && bodyDef(registry, secondary).kind !== 'star') {
        const point = `L${match[2]}` as keyof LagrangePoints;
        return { id, state: ephemeris.lagrangeStateAt(secondary as OrbitingId, point, t), hasMass: false, attractor: null };
      }
    }
    const entity = this.resolveEntity(id, entities);
    return entity ? { id, state: entity.state, hasMass: false, attractor: null } : null;
  }

  // id が航法ターゲットになれる(軌道面が定まる)かどうか。
  canTarget(id: string, entities: EntityManager, ephemeris: Ephemeris, t: number): boolean {
    return this.resolvePlaneNormal(id, entities, ephemeris, t) !== null;
  }

  // id から対象の軌道面法線を求める。船・基地は自身の軌道要素、公転している天体(惑星・衛星)
  // はその公転面法線、ラグランジュ点(`${副天体}-l${n}`)は副天体の公転面法線を使う。
  // 面が定まらない対象(恒星、および軌道要素の無い天体・存在しない船)は null。
  private resolvePlaneNormal(id: string, entities: EntityManager, ephemeris: Ephemeris, t: number): Vec3 | null {
    const registry = ephemeris.registry;
    if (id in registry && bodyDef(registry, id).kind !== 'star') {
      return ephemeris.orbitNormalAt(id as OrbitingId, t);
    }
    // 副天体がレジストリに実在する公転天体のときだけラグランジュ点として解釈する。そうしないと
    // 同じ形の名前を持つ船が天体として誤って解決される。
    const secondary = /^(.+)-l[1-5]$/.exec(id)?.[1];
    if (secondary !== undefined && secondary in registry && bodyDef(registry, secondary).kind !== 'star') {
      return qRotate(ephemeris.orbitFrameRotationAt(secondary as OrbitingId, t).q, Z_HAT);
    }
    const entity = this.resolveEntity(id, entities);
    if (!entity) return null;
    const center = strongestAttractor(entity.state.r, ephemeris.celestialBodiesAt(t));
    return entity.orbitalElementsAround(center)?.hHat ?? null;
  }

  // id を生存中の敵・自機・基地として引く。天体・ラグランジュ点は実体を持たないので null。
  private resolveEntity(id: string, entities: EntityManager): CombatTarget | null {
    const enemy = entities.findEnemy(id);
    return (enemy?.alive ? enemy : null)
      ?? entities.players.find((p) => p.id === id)
      ?? entities.bases.find((b) => b.id === id && b.alive)
      ?? null;
  }

  // 右クリック対象として公開する AN/DN アイコン。計算できているぶんだけ返す。
  mapPickables(): MapPickable[] {
    this.pickableCache.length = 0;
    const ownerName = this.ownerName ?? undefined;
    if (this.anPos && this.anTime !== null) this.pickableCache.push({ id: 'nav-an', name: 'AN', pos: this.anPos, time: this.anTime, kind: 'relnode', ownerName });
    if (this.dnPos && this.dnTime !== null) this.pickableCache.push({ id: 'nav-dn', name: 'DN', pos: this.dnPos, time: this.dnTime, kind: 'relnode', ownerName });
    return this.pickableCache;
  }

  // マップビューでは、天体に遮蔽されて画面上見えていない AN/DN を隠す(戦闘ビューでは効かせない)。
  sync(cameraSystem: CameraSystem): void {
    const project = cameraSystem.activeCameraProjection;
    const overviewMode = cameraSystem.overviewMode;
    const cameraPos = cameraSystem.activeCameraPos;
    if (!this.anPos) this.markerManager.hide('nav-an');
    else this.markerManager.setNodePosition('nav-an', 'mk-node', ORBIT_POINT_GLYPH.ascendingNode, this.anPos, project, cameraPos, this.celestialBodies, overviewMode, 'AN');
    if (!this.dnPos) this.markerManager.hide('nav-dn');
    else this.markerManager.setNodePosition('nav-dn', 'mk-node', ORBIT_POINT_GLYPH.descendingNode, this.dnPos, project, cameraPos, this.celestialBodies, overviewMode, 'DN');
  }
}
