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
import { validateEllipticPlacement } from '../creative/placement-validation';

const DEG = Math.PI / 180;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  readonly selectLabel = 'CREATIVE';
  readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  readonly hiddenFromSelect = true;
  readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  private placerPanel!: ShipPlacerPanel;
  private nextShipId = 1;

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

  // 未配置の開始状態では Stage.sync の player 前提を満たせないため、配置パネルだけを更新する。
  syncWithoutPlayer(overviewMode: boolean): void {
    this.placerPanel.setVisible(overviewMode);
  }

  // フォーム値から OrbitState を組み立て、addShip で1隻配置する。上限に達していれば
  // ヒントを出すだけで何もしない。
  private placeShip(name: string, form: ShipPlacerForm): void {
    if (this._entities.players.length >= C.CREATIVE_MAX_SHIPS) {
      this._hud.hint(`配置数が上限(${C.CREATIVE_MAX_SHIPS}隻)に達しています`);
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      const id = `creative-ship-${this.nextShipId++}`;
      const ship = new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, name, state, id);
      this._entities.addPlayer(ship);
      // 最初に配置した艦だけを操作対象にする。Game は callback 経由で受ける。
      this.onShipPlaced?.(ship);
      this._hud.hint(`${ship.displayName} を配置`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '入力を解釈できません';
      this._hud.hint(`配置できません: ${message}`, 5000);
    }
  }

  // Game が Creative のみで接続する。Stage 基底を複数船の概念で汚さない。
  onShipPlaced: ((ship: Player) => void) | null = null;

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

  private assertValidElementsForm(form: ShipPlacerForm): void {
    const rBody = form.body === 'moon' ? R_MOON : C.R_EARTH;
    const message = validateEllipticPlacement({
      bodyRadius: rBody, mu: form.body === 'moon' ? MU_MOON : C.MU_EARTH, sizeMode: form.sizeMode,
      peAltKm: form.peAltKm, apAltKm: form.apAltKm, semiMajorKm: form.semiMajorKm,
      eccentricity: form.eccentricity, periodHours: form.periodHours,
      anglesDeg: [form.incDeg, form.raanDeg, form.argpDeg, form.nuDeg],
    });
    if (message) throw new Error(message);
  }

  private assertValidForm(form: ShipPlacerForm): void {
    if (form.placementMode === 'elements') {
      this.assertValidElementsForm(form);
      return;
    }
    const values = [form.axKm, form.azKm];
    if (!values.every(Number.isFinite) || form.azKm <= 0 || (form.librationOrbitKind === 'lissajous' && form.axKm <= 0)) {
      throw new Error('ラグランジュ軌道の振幅には有限の正数を入力してください');
    }
  }

  private assertFiniteEllipticState(state: OrbitState): void {
    const values = [state.r.x, state.r.y, state.r.z, state.v.x, state.v.y, state.v.z];
    if (!values.every(Number.isFinite)) throw new Error('有限の状態を作れませんでした');
  }

  // ノード適用は Simulator のイベント境界で行うため、フレーム更新では何もしない。
  update(_dt: number, player: Player, _entities: EntityManager, simTime: number, _simSpeed: SimSpeedManager): void {
    // Creative は戦闘フェーズを持たないため、以前は補給ロジスティクスも
    // 更新されていなかった。その結果、初期弾薬が 0 の Creative 艦は
    // いったん弾を使い切ると補給が永遠に投入されなかった。
    // 通常ステージと同じ残弾監視・回収・遠方補給の再投入を行う。
    this.logistics.updateLogistics(simTime, player, true);
  }

  // followPlan のノードは Simulator の既知イベントとして扱い、必ずnode.tちょうどで積分を切る。
  // これにより、フレーム末に過去epochのstateを代入する巻き戻しと、バーン前軌道での越境を防ぐ。
  nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._entities.players) {
      if (!ship.followPlan) continue;
      const t = ship.plan.firstNode()?.t;
      if (t !== undefined && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  applySimulationEvents(simTime: number): void {
    for (const ship of this._entities.players) {
      if (!ship.followPlan) continue;
      const node = ship.plan.firstNode();
      if (!node || node.t > simTime + 1e-9) continue;
      const reached = ship.plan.dropNodesBefore(simTime);
      if (reached) ship.state = reached;
    }
  }

  checkWin(): boolean {
    return false;
  }

  // 勝敗のないモードなので、艦を喪失しても敗北画面は出さず通知だけにする。
  recordPlayerLost(reason: string): void {
    this._hud.hint(reason);
  }
}
