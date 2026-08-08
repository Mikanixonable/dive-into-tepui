// マップ上の航法ターゲット(任意の MapPickable)の保持と、自機軌道との相対 AN/DN(昇交点・
// 降交点)の算出・マーカー表示・被選択物としての公開。Targeter の戦闘ターゲット(Enemy 専用)
// とは独立に、月・ラグランジュ点なども対象にできる。
import { Vec3, cross, dot, norm, scale, v3 } from '../physics/vec3';
import { tofBetween, trueAnomalyAt } from '../physics/elements';
import { AttractorId, OrbitingId, strongestAttractor } from '../physics/attractor';
import { bodyDef, SOLAR_SYSTEM } from '../physics/solar-system';
import type { Ephemeris } from '../physics/ephemeris';
import { qRotate } from '../physics/attitude';
import { Player } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import type { EntityManager } from './simulation/entity-manager';
import { Hud } from './hud/hud';
import { MarkerManager } from './marker/marker-manager';
import { ProjectFn } from './camera/camera-system';
import { MapPickable, pickNearest } from './map-pick';
import type { Base } from './game-entity/base';
import type { Input } from './input/input';
import * as C from './const';
import { ContextMenu } from './hud/context-menu';
import { MenuAction, MenuCommon } from './hud/menu-actions';

const Z_HAT: Vec3 = v3(0, 0, 1);

export class NavTarget {
  // 戦闘ビューで基地を右クリックしたときの航法ターゲット設定/解除メニュー。
  private readonly baseMenu = new ContextMenu<Base, MenuAction>();
  private targetId: string | null = null;
  private targetName: string | null = null;
  // 自機軌道上の AN/DN の絶対位置(地球中心)。対象の軌道面が定まらなければ両方 null。
  private anPos: Vec3 | null = null;
  private dnPos: Vec3 | null = null;
  // AN/DN 通過の絶対時刻 [s]。自機軌道要素の現在真近点角からの飛行時間を加えて求める。
  private anTime: number | null = null;
  private dnTime: number | null = null;

  constructor(private readonly _hud: Hud, private readonly markerManager: MarkerManager) {
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
  update(player: Player | null, entities: EntityManager, ephemeris: Ephemeris, simTime: number): void {
    this.anPos = this.dnPos = this.anTime = this.dnTime = null;
    if (!player || !this.targetId) return;
    const playerCenter = strongestAttractor(player.state.r, ephemeris.attractorsAt(simTime));
    const playerEl = player.orbitalElementsAround(playerCenter);
    if (!playerEl) return;

    const targetHat = this.resolvePlaneNormal(this.targetId, entities, ephemeris, simTime);
    if (!targetHat) return;

    const lineDir = cross(playerEl.hHat, targetHat);
    if (dot(lineDir, lineDir) < 1e-6) return; // 軌道面がほぼ一致 → 交線が定まらない

    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, playerEl.qHat), dot(d, playerEl.pHat));
    const rAsc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc));
    const rDesc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc + Math.PI));
    this.anPos = scale(d, rAsc);
    this.dnPos = scale(d, -rDesc);

    const nu0 = trueAnomalyAt(playerEl, player.state.r);
    this.anTime = simTime + tofBetween(playerEl, nu0, thAsc);
    this.dnTime = simTime + tofBetween(playerEl, nu0, thAsc + Math.PI);
  }

  clearIfTargeting(id: string): void {
    if (this.targetId === id) this.targetId = null;
  }

  // 戦闘ビューの右クリックで基地を航法ターゲットに設定/解除する。基地に当たらなければ
  // クリックを消費せず、Targeter の敵ターゲット選択へフォールスルーさせる。
  updateCombatBasePicking(entities: EntityManager, input: Input, project: ProjectFn): void {
    input.takeRightClicks((click) => {
      const pickables = entities.bases.filter((b) => b.alive).map((base) => ({ pos: base.state.r, base }));
      const hit = pickNearest(pickables, click.x, click.y, project, C.TARGET_LOCK_PICK_PX_SQ);
      if (!hit) return false;
      this.baseMenu.open(click.x, click.y, hit.base, [
        MenuCommon.navTarget(this.targetId === hit.base.id),
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
    if (id in SOLAR_SYSTEM && bodyDef(id as AttractorId).kind !== 'star') {
      return ephemeris.orbitNormalAt(id as OrbitingId, t);
    }
    // 副天体がレジストリに実在する公転天体のときだけラグランジュ点として解釈する。そうしないと
    // 同じ形の名前を持つ船が天体として誤って解決される。
    const secondary = /^(.+)-l[1-5]$/.exec(id)?.[1];
    if (secondary !== undefined && secondary in SOLAR_SYSTEM && bodyDef(secondary as AttractorId).kind !== 'star') {
      return qRotate(ephemeris.orbitFrameRotationAt(secondary as OrbitingId, t).q, Z_HAT);
    }
    const entity: GameEntity | undefined =
      entities.enemies.find((e) => e.name === id && e.alive) ??
      entities.players.find((p) => p.id === id && p.alive) ??
      entities.bases.find((b) => b.id === id && b.alive);
    if (!entity) return null;
    const center = strongestAttractor(entity.state.r, ephemeris.attractorsAt(t));
    return entity.orbitalElementsAround(center)?.hHat ?? null;
  }

  // 右クリック対象として公開する AN/DN アイコン。計算できているぶんだけ返す。
  mapPickables(): MapPickable[] {
    const items: MapPickable[] = [];
    if (this.anPos && this.anTime !== null) items.push({ id: 'nav-an', name: 'AN', pos: this.anPos, time: this.anTime, kind: 'relnode' });
    if (this.dnPos && this.dnTime !== null) items.push({ id: 'nav-dn', name: 'DN', pos: this.dnPos, time: this.dnTime, kind: 'relnode' });
    return items;
  }

  sync(project: ProjectFn): void {
    if (this.anPos) this.markerManager.setPosition('nav-an', 'mk-node', '▲', this.anPos, project, 'AN');
    else this.markerManager.hide('nav-an');
    if (this.dnPos) this.markerManager.setPosition('nav-dn', 'mk-node', '▽', this.dnPos, project, 'DN');
    else this.markerManager.hide('nav-dn');
  }
}
