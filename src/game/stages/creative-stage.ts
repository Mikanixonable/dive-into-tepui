// クリエイティブモード: 勝敗判定を発生させず、艦艇配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import { OrbitState, orbitState, semiMajorFromPeriod, stateFromElements } from '../../physics/orbital';
import { Ephemeris, MU_MOON, R_MOON } from '../../physics/ephemeris';
import { haloState, lissajousState } from '../../physics/halo';
import { add } from '../../physics/vec3';
import type { ProjectFn } from '../camera/camera-system';
import * as C from '../const';
import { CreativeShip } from '../game-entity/creative-ship';
import { ShipPlacerForm, ShipPlacerPanel } from '../creative/ship-placer-panel';

const DEG = Math.PI / 180;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  readonly selectLabel = 'CREATIVE';
  readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  readonly hiddenFromSelect = true;
  readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  private _markerManager!: MarkerManager;
  private _ephemeris!: Ephemeris;
  private _entities!: EntityManager;
  private placerPanel!: ShipPlacerPanel;
  private simTime = 0;

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // Stage.setup が受け取らない markerManager/ephemeris をここで補う。前者は addShip が
  // CreativeShip を組み立てるのに、後者は艦艇配置パネルが月中心軌道を ECI 化するのに要る。
  setupCreative(markerManager: MarkerManager, ephemeris: Ephemeris): void {
    this._markerManager = markerManager;
    this._ephemeris = ephemeris;
    this.placerPanel = new ShipPlacerPanel(this._hud.root);
    this.placerPanel.onConfirm = (name, form) => this.placeShip(name, form);
  }

  init(_player: Player, entities: EntityManager): number {
    this._entities = entities;
    return 0;
  }

  // 艦艇配置パネルはマップモード中のみ表示する。
  sync(player: Player, project: ProjectFn, displayTime: number, overviewMode: boolean): void {
    super.sync(player, project, displayTime, overviewMode);
    this.placerPanel.setVisible(overviewMode);
  }

  // フォーム値から OrbitState を組み立て、addShip で1隻配置する。上限に達していれば
  // ヒントを出すだけで何もしない。
  private placeShip(name: string, form: ShipPlacerForm): void {
    const state = this.buildInitialState(form);
    const ship = this.addShip(this._hud, this._sfx, this._scene, this._fx, this._entities, name, state);
    if (!ship) this._hud.hint(`配置数が上限(${C.CREATIVE_MAX_SHIPS}隻)に達しています`);
    else this._hud.hint(`${name} を配置`);
  }

  // フォームの placementMode に応じて軌道要素指定(stateFromElements)かラグランジュ点指定
  // (haloState/lissajousState)のどちらかで OrbitState を組み立てる。
  private buildInitialState(form: ShipPlacerForm): OrbitState {
    if (form.placementMode === 'libration') return this.buildLibrationState(form);
    return this.buildElementsState(form);
  }

  // 系・点・軌道種別・面内/面外振幅から、ラグランジュ点まわりのハロー/リサジュー軌道の
  // 初期状態を組む。ECI 位置・速度は haloState/lissajousState がそのまま返す。
  private buildLibrationState(form: ShipPlacerForm): OrbitState {
    const params = {
      system: form.librationSystem,
      point: form.librationPoint,
      ax: form.axKm * 1e3,
      az: form.azKm * 1e3,
    };
    return form.librationOrbitKind === 'halo'
      ? haloState(this.simTime, this._ephemeris, params)
      : lissajousState(this.simTime, this._ephemeris, params);
  }

  // フォームが選んだサイズ/形の組から長半径・離心率を導出し、要素→状態変換
  // (stateFromElements)へ渡す。月基準では月中心の要素で組んでから月の位置・速度を足す。
  private buildElementsState(form: ShipPlacerForm): OrbitState {
    const mu = form.body === 'moon' ? MU_MOON : C.MU_EARTH;
    const rBody = form.body === 'moon' ? R_MOON : C.R_EARTH;
    // フォームが選んだ組(sizeMode)から長半径・離心率を導出する。
    let a: number;
    let e: number;
    if (form.sizeMode === 'apsides') {
      const rp = rBody + form.peAltKm * 1e3;
      const ra = rBody + form.apAltKm * 1e3;
      a = (rp + ra) / 2;
      e = (ra - rp) / (ra + rp);
    } else if (form.sizeMode === 'semiMajorEcc') {
      a = form.semiMajorKm * 1e3;
      e = form.eccentricity;
    } else {
      a = semiMajorFromPeriod(form.periodHours * 3600, mu);
      e = form.eccentricity;
    }

    // 主天体中心(地球 or 月)の相対状態。月基準ならこの時点では月中心の値。
    const rel = stateFromElements(
      this.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG, form.nuDeg * DEG, mu,
    );
    if (form.body === 'earth') return rel;

    // 月中心の相対状態に月自身の位置・速度を足して ECI 化する。
    const moonPos = this._ephemeris.moonPosAt(this.simTime);
    const moonVel = this._ephemeris.moonVelAt(this.simTime);
    return orbitState(this.simTime, add(moonPos, rel.r), add(moonVel, rel.v));
  }

  // entities.creativeShips へ CreativeShip を1隻追加する。CREATIVE_MAX_SHIPS に達していれば
  // 追加せず null を返す。軌道要素を指定した配置 UI はここを呼ぶ。
  addShip(
    hud: Hud, sfx: Sfx, scene: THREE.Scene, fx: EffectsSystem,
    entities: EntityManager, name: string, initialState: OrbitState,
  ): CreativeShip | null {
    if (entities.creativeShips.length >= C.CREATIVE_MAX_SHIPS) return null;
    const ship = new CreativeShip(hud, sfx, scene, fx, this._markerManager, name, initialState);
    entities.addCreativeShip(ship);
    return ship;
  }

  // クリエイティブ艦を配置から取り除く。
  removeShip(entities: EntityManager, ship: CreativeShip): void {
    entities.removeCreativeShip(ship);
  }

  // 軌道計画への自動追従(followPlan)が ON の艦それぞれについて、次ノードの時刻へ達したかを
  // 見て、達していれば state をそのノードの絶対状態へ置き換えて消費する(有限推力のバーン模擬は
  // 行わない — ノードは既にバーン後の絶対状態のため、置き換えるだけで計画軌道と厳密に一致する)。
  // simTime は艦艇配置パネルの confirm(DOM イベントとして非同期に発火する)が配置先の時刻を
  // 引くのに使うため、ここで毎フレーム覚え直す。
  update(_dt: number, _player: Player, entities: EntityManager, simTime: number, _simSpeed: SimSpeedManager): void {
    this.simTime = simTime;
    for (const ship of entities.creativeShips) this.advanceFollowPlan(ship, simTime);
  }

  private advanceFollowPlan(ship: CreativeShip, simTime: number): void {
    if (!ship.followPlan) return;
    const reached = ship.plan.dropNodesBefore(simTime);
    if (reached) ship.state = reached;
  }

  checkWin(): boolean {
    return false;
  }
}
