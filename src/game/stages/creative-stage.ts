// クリエイティブモード: 勝敗判定を発生させず、艦艇配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage } from './stage';
import { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { Simulator } from '../simulation/simulator';
import type { MarkerManager } from '../marker/marker-manager';
import { OrbitState, orbitState, semiMajorFromPeriod, stateFromElements } from '../../physics/orbital';
import { Ephemeris, MU_MOON, R_MOON } from '../../physics/ephemeris';
import { haloState, lissajousState } from '../../physics/halo';
import { add } from '../../physics/vec3';
import type { ProjectFn } from '../camera/camera-system';
import type { UnlockManager } from '../unlock-manager';
import * as C from '../const';
import { ShipPlacerForm, ShipPlacerPanel } from '../creative/ship-placer-panel';

const DEG = Math.PI / 180;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  readonly selectLabel = 'CREATIVE';
  readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  readonly hiddenFromSelect = true;
  readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  private placerPanel!: ShipPlacerPanel;

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // 共通リソースの注入に加え、艦艇配置パネルを組み立てて確定の宛先を自身にする。
  setup(
    hud: Hud, sfx: Sfx, scene: THREE.Scene, entities: EntityManager, unlockManager: UnlockManager,
    fx: EffectsSystem, markerManager: MarkerManager, ephemeris: Ephemeris, simulator: Simulator,
  ): void {
    super.setup(hud, sfx, scene, entities, unlockManager, fx, markerManager, ephemeris, simulator);
    this.placerPanel = new ShipPlacerPanel(hud.root);
    this.placerPanel.onConfirm = (name, form) => this.placeShip(name, form);
  }

  init(): number {
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
    if (this._entities.players.length >= C.CREATIVE_MAX_SHIPS) {
      this._hud.hint(`配置数が上限(${C.CREATIVE_MAX_SHIPS}隻)に達しています`);
      return;
    }
    const state = this.buildInitialState(form);
    this._entities.addPlayer(
      new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, name, state),
    );
    this._hud.hint(`${name} を配置`);
  }

  // フォームの placementMode に応じて軌道要素指定(stateFromElements)かラグランジュ点指定
  // (haloState/lissajousState)のどちらかで OrbitState を組み立てる。
  private buildInitialState(form: ShipPlacerForm): OrbitState {
    if (form.placementMode === 'libration') return this.buildLibrationState(form);
    return this.buildElementsState(form);
  }

  // 系・点・軌道種別・振幅から、ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。
  // ハローの面内振幅は三次の振幅拘束で面外振幅から決まるので、フォームの面内振幅は使わない。
  private buildLibrationState(form: ShipPlacerForm): OrbitState {
    const common = { system: form.librationSystem, point: form.librationPoint };
    if (form.librationOrbitKind === 'halo') {
      return haloState(this._simulator.simTime, this._ephemeris, { ...common, az: form.azKm * 1e3 });
    }
    return lissajousState(this._simulator.simTime, this._ephemeris, {
      ...common, ax: form.axKm * 1e3, az: form.azKm * 1e3,
    });
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
      this._simulator.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG, form.nuDeg * DEG, mu,
    );
    if (form.body === 'earth') return rel;

    // 月中心の相対状態に月自身の位置・速度を足して ECI 化する。
    const moonPos = this._ephemeris.moonPosAt(this._simulator.simTime);
    const moonVel = this._ephemeris.moonVelAt(this._simulator.simTime);
    return orbitState(this._simulator.simTime, add(moonPos, rel.r), add(moonVel, rel.v));
  }

  // 軌道計画への自動追従(followPlan)が ON の艦それぞれについて、次ノードの時刻へ達したかを
  // 見て、達していれば state をそのノードの絶対状態へ置き換えて消費する(有限推力のバーン模擬は
  // 行わない — ノードは既にバーン後の絶対状態のため、置き換えるだけで計画軌道と厳密に一致する)。
  update(_dt: number, _player: Player, entities: EntityManager, simTime: number, _simSpeed: SimSpeedManager): void {
    for (const ship of entities.players) this.advanceFollowPlan(ship, simTime);
  }

  private advanceFollowPlan(ship: Player, simTime: number): void {
    if (!ship.followPlan) return;
    const reached = ship.plan.dropNodesBefore(simTime);
    if (reached) ship.state = reached;
  }

  checkWin(): boolean {
    return false;
  }

  // 勝敗のないモードなので、艦を喪失しても敗北画面は出さず通知だけにする。
  recordPlayerLost(reason: string): void {
    this._hud.hint(reason);
  }
}
