// マップ上の航法ターゲット(任意の MapPickable)の保持と、自機軌道との相対 AN/DN(昇交点・
// 降交点)の算出・マーカー表示・被選択物としての公開。Targeter の戦闘ターゲット(Enemy 専用)
// とは独立に、月・ラグランジュ点なども対象にできる。
import { Vec3, v3 } from '../physics/vec3';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from '../physics/elements';
import { Attractor, OrbitingId, frameOfAttractor, strongestAttractor } from '../physics/attractor';
import { isOccluded } from '../physics/occlusion';
import { frameKinematicState, toFrameState, toInertialState } from '../physics/frame';
import { bodyDef } from '../physics/solar-system';
import type { Ephemeris } from '../physics/ephemeris';
import { qRotate } from '../physics/attitude';
import { Player } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import type { DisplayWindow } from './display-window-manager';
import type { EntityManager } from './simulation/entity-manager';
import { Hud } from './hud/hud';
import { MarkerManager } from './marker/marker-manager';
import { ORBIT_POINT_GLYPH } from './marker/marker-glyphs';
import { CameraSystem, ProjectFn } from './camera/camera-system';
import { MapPickable, pickNearest } from './map-pick';
import type { Base } from './game-entity/base';
import type { Input } from './input/input';
import * as C from './const';
import { ContextMenu } from './hud/context-menu';
import { MenuAction, MenuCommon } from './hud/menu-actions';

const Z_HAT: Vec3 = v3(0, 0, 1);

export class NavTarget {
  // 戦闘ビューで基地を右クリックしたときの航法ターゲット設定/解除メニュー。
  private readonly baseMenu: ContextMenu<Base, MenuAction>;
  private targetId: string | null = null;
  private targetName: string | null = null;
  // 自機軌道上の AN/DN の絶対位置(地球中心)。対象の軌道面が定まらなければ両方 null。
  private anPos: Vec3 | null = null;
  private dnPos: Vec3 | null = null;
  // AN/DN 通過の絶対時刻 [s]。自機軌道要素の現在真近点角からの飛行時間を加えて求める。
  private anTime: number | null = null;
  private dnTime: number | null = null;
  // update が求めた時点の Attractor[]。sync でのマップビュー遮蔽判定に使う。
  private attractors: readonly Attractor[] = [];
  private readonly pickableCache: MapPickable[] = [];

  constructor(private readonly _hud: Hud, private readonly markerManager: MarkerManager) {
    this.baseMenu = new ContextMenu<Base, MenuAction>(_hud.layers.popup);
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

  // id と現在の設定が同じなら解除、そうでなければ id を航法ターゲットにする。
  toggleTarget(id: string, name: string): void {
    if (this.targetId === id) {
      this.targetId = null;
      this.targetName = null;
      this._hud.hint('航法ターゲット解除');
    } else {
      this.targetId = id;
      this.targetName = name;
      this._hud.hint(`航法ターゲット: ${name}`);
    }
  }

  // AN/DN の通過時刻 [s]。id は 'nav-an'/'nav-dn'。未計算・対象外なら null。
  passTimeOf(id: string): number | null {
    if (id === 'nav-an') return this.anTime;
    if (id === 'nav-dn') return this.dnTime;
    return null;
  }

  // 自機軌道要素と対象の軌道面法線から相対 AN/DN の位置・通過時刻を求め直す。
  // 対象の軌道面が定まらない(地球・太陽自身など)場合や自機軌道要素が無い場合は両方 null にする。
  // positionOnOrbit は中心天体基準の相対位置を返すので、frameOfAttractor + toInertialState で
  // 絶対 ECI 位置へ直す — 地球周回では中心が原点に一致するため偶然一致するが、月周回では
  // 直さないと月までの距離ぶんずれる。
  update(
    player: Player | null, entities: EntityManager, ephemeris: Ephemeris, displayWindow: DisplayWindow,
  ): void {
    const simTime = displayWindow.simTime;
    this.anPos = this.dnPos = this.anTime = this.dnTime = null;
    this.attractors = ephemeris.attractorsAt(simTime);
    if (!this.targetId) return;
    // 航法ターゲット自身の赤道交点は、自機の軌道要素が求まるかどうかとは無関係に出す。
    const target = this.resolveEntity(this.targetId, entities);
    target?.ensureEquatorNodes(this.markerManager)
      .update(displayWindow.frame, displayWindow.displayTime, ephemeris);
    if (!player) return;
    const playerCenter = strongestAttractor(player.state.r, this.attractors);
    const playerEl = player.orbitalElementsAround(playerCenter);
    if (!playerEl) return;

    const targetHat = this.resolvePlaneNormal(this.targetId, entities, ephemeris, simTime);
    if (!targetHat) return;

    const nodes = nodeAnomalies(playerEl, targetHat);
    if (!nodes) return;

    const tf = frameOfAttractor(playerCenter);
    const nu0 = trueAnomalyAt(playerEl, toFrameState(tf, player.state).r);
    const anT = simTime + tofBetween(playerEl, nu0, nodes.asc);
    const dnT = simTime + tofBetween(playerEl, nu0, nodes.desc);
    this.anPos = toInertialState(tf, anT, frameKinematicState(positionOnOrbit(playerEl, nodes.asc), v3(0, 0, 0))).r;
    this.dnPos = toInertialState(tf, dnT, frameKinematicState(positionOnOrbit(playerEl, nodes.desc), v3(0, 0, 0))).r;
    this.anTime = anT;
    this.dnTime = dnT;
  }

  clearIfTargeting(id: string): void {
    if (this.targetId === id) this.targetId = null;
  }

  // 戦闘ビューの右クリックで基地を航法ターゲットに設定/解除する。基地に当たらなければ
  // クリックを消費せず、Targeter の敵ターゲット選択へフォールスルーさせる。ビューはここでは
  // 持たないので毎フレーム引数で受け取り、マップ視点では何もしない。
  updateCombatBasePicking(entities: EntityManager, input: Input, project: ProjectFn, overviewMode: boolean): void {
    if (overviewMode) return;
    input.takeRightClicks((click) => {
      const pickables = entities.bases.filter((b) => b.alive).map((base) => ({ pos: base.state.r, base }));
      const picked = pickNearest(pickables, click.x, click.y, project, C.TARGET_LOCK_PICK_PX_SQ);
      if (!picked) return false;
      this.baseMenu.open(click.x, click.y, picked.base, [
        MenuCommon.navTarget(this.targetId === picked.base.id),
        MenuCommon.cancel(),
      ]);
      return true;
    });
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
    const center = strongestAttractor(entity.state.r, ephemeris.attractorsAt(t));
    return entity.orbitalElementsAround(center)?.hHat ?? null;
  }

  // id を生存中の敵・自機・基地として引く。天体・ラグランジュ点は実体を持たないので null。
  private resolveEntity(id: string, entities: EntityManager): GameEntity | null {
    const enemy = entities.findEnemy(id);
    return (enemy?.alive ? enemy : null)
      ?? entities.players.find((p) => p.id === id)
      ?? entities.bases.find((b) => b.id === id && b.alive)
      ?? null;
  }

  // 右クリック対象として公開する AN/DN アイコン。計算できているぶんだけ返す。
  mapPickables(): MapPickable[] {
    this.pickableCache.length = 0;
    if (this.anPos && this.anTime !== null) this.pickableCache.push({ id: 'nav-an', name: 'AN', pos: this.anPos, time: this.anTime, kind: 'relnode' });
    if (this.dnPos && this.dnTime !== null) this.pickableCache.push({ id: 'nav-dn', name: 'DN', pos: this.dnPos, time: this.dnTime, kind: 'relnode' });
    return this.pickableCache;
  }

  // マップビューでは、天体に遮蔽されて画面上見えていない AN/DN を隠す(戦闘ビューでは効かせない)。
  sync(cameraSystem: CameraSystem): void {
    const project = cameraSystem.activeCameraProjection;
    const overviewMode = cameraSystem.overviewMode;
    const cameraPos = cameraSystem.activeCameraPos;
    const hidden = (pos: Vec3): boolean => overviewMode && isOccluded(cameraPos, pos, this.attractors);
    if (this.anPos && !hidden(this.anPos)) this.markerManager.setPosition('nav-an', 'mk-node', ORBIT_POINT_GLYPH.ascendingNode, this.anPos, project, 'AN');
    else this.markerManager.hide('nav-an');
    if (this.dnPos && !hidden(this.dnPos)) this.markerManager.setPosition('nav-dn', 'mk-node', ORBIT_POINT_GLYPH.descendingNode, this.dnPos, project, 'DN');
    else this.markerManager.hide('nav-dn');
  }
}
