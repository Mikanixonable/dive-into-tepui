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
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, semiMajorFromPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { Attractor, orbitalElementsOf } from '../../physics/attractor';
import { Ephemeris } from '../../physics/ephemeris';
import { haloState, lissajousState } from '../../physics/halo';
import type { FloatingOrigin } from '../floating-origin';
import { Vec3, add, len, sub } from '../../physics/vec3';
import { fmtMarkerDist } from '../hud/utils';
import type { ProjectFn } from '../camera/camera-system';
import type { UnlockManager } from '../unlock-manager';
import { Ammo } from '../game-entity/ammo';
import { Base } from '../game-entity/base';
import { generateDriftingEnemy } from './spawner/enemy-generator';
import * as C from '../const';
import { ShipPlacerForm, ShipPlacerPanel } from '../creative/ship-placer-panel';
import { validateEllipticPlacement } from '../creative/placement-validation';
import { OrbitLine } from '../../render/orbitline';

const DEG = Math.PI / 180;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  readonly stageId = 'creative' as const;
  readonly selectLabel = 'CREATIVE';
  readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  readonly hiddenFromSelect = true;
  readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  private placerPanel!: ShipPlacerPanel;
  private previewOrbitLine!: OrbitLine;
  // 艦艇配置パネルのフォーム値から求めた配置プレビュー。出すものが無ければ null。
  private preview: { readonly elements: OrbitalElements; readonly pos: Vec3 } | null = null;
  private nextShipId = 1;
  private lastBaseMarkerCount = 0;

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // 共通リソースの注入に加え、艦艇配置パネルを組み立てて確定の宛先を自身にする。
  setup(
    hud: Hud, sfx: Sfx, scene: THREE.Scene, entities: EntityManager, unlockManager: UnlockManager,
    fx: EffectsSystem, markerManager: MarkerManager, ephemeris: Ephemeris, simulator: Simulator,
  ): void {
    super.setup(hud, sfx, scene, entities, unlockManager, fx, markerManager, ephemeris, simulator);

    this.previewOrbitLine = new OrbitLine(0xffffff, 0.6);
    scene.add(this.previewOrbitLine.line);

    this.placerPanel = new ShipPlacerPanel(hud.root);
    this.placerPanel.onConfirm = (name, form) => this.placeObject(name, form);
  }

  init(): number {
    return 0;
  }

  // 共通のステータス表示に加えて、配置プレビューの軌道線とマーカー、基地マーカーを同期する。
  sync(player: Player | null, fo: FloatingOrigin, project: ProjectFn, displayTime: number, overviewMode: boolean): void {
    super.sync(player, fo, project, displayTime, overviewMode);
    this.syncPreview(fo, project);
    this.syncBaseMarkers(project, displayTime, player, overviewMode);
  }

  // 基地は実寸(半径100m)のメッシュしか持たず、マップ視点では見えないほど小さいので、
  // FocusMarkers と同じ ● のポイントマーカーを立てて発見できるようにする。戦闘ビューでは
  // 自機からの距離をラベルに添え、画面外なら ▣ AMMO と同じ方式の方位矢印で補う。
  private syncBaseMarkers(project: ProjectFn, displayTime: number, player: Player | null, overviewMode: boolean): void {
    const bases = this._entities.bases;
    for (const [i, base] of bases.entries()) {
      const key = `base${i}`;
      const bearingKey = `${key}-bearing`;
      const pos = base.alive ? base.displayState(displayTime)?.r : undefined;
      if (!pos) {
        this._markerManager.hide(key);
        this._markerManager.hide(bearingKey);
        continue;
      }
      const label = player ? `基地 ${fmtMarkerDist(len(sub(pos, player.state.r)))}` : '基地';
      const p = project(pos);
      this._markerManager.set(key, 'mk-poi', '●', p.x, p.y, p.front, label);
      if (overviewMode) this._markerManager.hide(bearingKey);
      else this._markerManager.setBearing(bearingKey, 'mk-poi', '●', p, label, 0.9);
    }
    for (let i = bases.length; i < this.lastBaseMarkerCount; i++) {
      this._markerManager.hide(`base${i}`);
      this._markerManager.hide(`base${i}-bearing`);
    }
    this.lastBaseMarkerCount = bases.length;
  }

  // 艦艇配置モーダルを開く (MapPicker から呼ばれる)
  openShipPlacer(): void {
    this.placerPanel.setVisible(true);
  }

  // フォーム値から配置プレビューの軌道要素と位置を求める。パネルを閉じている間・軌道要素指定
  // 以外の配置方法・入力を解釈できない値のときは null(プレビューを出さない)。
  private computePreview(): { elements: OrbitalElements; pos: Vec3 } | null {
    if (!this.placerPanel.isOpen) return null;
    const form = this.placerPanel.getForm();
    if (form.placementMode !== 'elements') return null;
    try {
      const state = this.buildInitialState(form);
      // 楕円はフォームが選んだ基準天体中心で描く。
      const elements = orbitalElementsOf(state, this.referenceAttractor(form));
      return elements ? { elements, pos: state.r } : null;
    } catch {
      return null;
    }
  }

  // 配置プレビューの軌道線と ▷ マーカーを update が求めた値へ同期する。
  private syncPreview(fo: FloatingOrigin, project: ProjectFn): void {
    if (!this.preview) {
      this.previewOrbitLine.sync(null, fo);
      this._markerManager.hide('creative-preview');
      return;
    }
    this.previewOrbitLine.sync(this.preview.elements, fo, true);
    this._markerManager.setPosition(
      'creative-preview', 'mk-self', '▷', this.preview.pos, project,
      'PREVIEW', 1, '#00ffff', 0, false, false,
    );
  }

  // フォーム値から KinematicState を組み立て、配置する。
  private placeObject(name: string, form: ShipPlacerForm): void {
    if (form.objectType === 'player' && this._entities.players.length >= C.CREATIVE_MAX_SHIPS) {
      this._hud.hint(`配置数が上限(${C.CREATIVE_MAX_SHIPS}隻)に達しています`);
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      
      if (form.objectType === 'player') {
        const id = `creative-player-${this.nextShipId++}`;
        const finalName = name || `Player-${this.nextShipId}`;
        const ship = new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, finalName, state, id);
        this._entities.addPlayer(ship);
        this.onShipPlaced?.(ship);
        this._hud.hint(`${ship.displayName} を配置`);
      } else if (form.objectType === 'enemy') {
        const finalName = name || `Enemy-${this.nextShipId++}`;
        const enemy = generateDriftingEnemy(finalName, state, C.ENEMY_MAX_HP, '#ff6a00', '#ff6a00', this._hud, this._sfx, this._fx, this._scene);
        this._entities.addEnemy(enemy);
        this._hud.hint(`${enemy.name} を配置`);
      } else if (form.objectType === 'ammo') {
        const id = `creative-ammo-${this.nextShipId++}`;
        const ammo = new Ammo(state, undefined, this._scene, id);
        this._entities.addAmmo(ammo);
        const finalName = name || `Ammo-${this.nextShipId}`;
        this._hud.hint(`${finalName} を配置`);
      } else if (form.objectType === 'base') {
        const base = new Base(state, this._scene);
        this._entities.addBase(base);
        const finalName = name || `Base-${this.nextShipId++}`;
        this._hud.hint(`${finalName} を配置`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '入力を解釈できません';
      this._hud.hint(`配置できません: ${message}`, 5000);
    }
  }

  // Game が Creative のみで接続する。Stage 基底を複数船の概念で汚さない。
  onShipPlaced: ((ship: Player) => void) | null = null;

  // フォームの placementMode に応じて軌道要素指定(stateFromOrbitalElements)かラグランジュ点指定
  // (haloState/lissajousState)のどちらかで KinematicState を組み立てる。
  private buildInitialState(form: ShipPlacerForm): KinematicState {
    if (form.placementMode === 'lagrange') return this.buildLagrangeState(form);
    return this.buildElementsState(form);
  }

  // 副天体・点・軌道種別・振幅から、ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。
  // ハローの面内振幅は三次の振幅拘束で面外振幅から決まるので、フォームの面内振幅は使わない。
  private buildLagrangeState(form: ShipPlacerForm): KinematicState {
    const common = { secondary: form.lagrangeSecondary, point: form.lagrangePoint };
    if (form.lagrangeOrbitKind === 'halo') {
      return haloState(this._simulator.simTime, this._ephemeris, { ...common, az: form.azKm * 1e3 });
    }
    return lissajousState(this._simulator.simTime, this._ephemeris, {
      ...common, ax: form.axKm * 1e3, az: form.azKm * 1e3,
    });
  }

  // フォームの基準天体(地球 or 月)を、その時刻の重力源として引く。μ・半径・ECI 化に
  // 要る情報がすべてここから出る。
  private referenceAttractor(form: ShipPlacerForm): Attractor {
    return this._ephemeris.attractorsAt(this._simulator.simTime).find((b) => b.id === form.attractor)!;
  }

  // フォームが選んだサイズ/形の組から長半径・離心率を導出し、要素→状態変換
  // (stateFromOrbitalElements)で基準天体中心の相対状態を組んでから、基準天体自身の位置・速度を
  // 足して ECI 化する(地球基準では位置・速度とも厳密に 0 なので、実質そのまま返る)。
  private buildElementsState(form: ShipPlacerForm): KinematicState {
    const center = this.referenceAttractor(form);
    let a: number;
    let e: number;
    if (form.sizeMode === 'apsides') {
      const rp = center.radius + form.peAltKm * 1e3;
      const ra = center.radius + form.apAltKm * 1e3;
      a = (rp + ra) / 2;
      e = (ra - rp) / (ra + rp);
    } else if (form.sizeMode === 'semiMajorEcc') {
      a = form.semiMajorKm * 1e3;
      e = form.eccentricity;
    } else {
      a = semiMajorFromPeriod(form.periodHours * 3600, center.mu);
      e = form.eccentricity;
    }

    const rel = stateFromOrbitalElements(
      this._simulator.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG, form.nuDeg * DEG, center.mu,
    );
    return kinematicState(this._simulator.simTime, add(center.state.r, rel.r), add(center.state.v, rel.v));
  }

  // 軌道要素指定フォームの値が物理的に成立するか検証する。不正なら理由付きで例外を投げる。
  private assertValidElementsForm(form: ShipPlacerForm): void {
    const center = this.referenceAttractor(form);
    const message = validateEllipticPlacement({
      centerRadius: center.radius, mu: center.mu, sizeMode: form.sizeMode,
      peAltKm: form.peAltKm, apAltKm: form.apAltKm, semiMajorKm: form.semiMajorKm,
      eccentricity: form.eccentricity, periodHours: form.periodHours,
      anglesDeg: [form.incDeg, form.raanDeg, form.argpDeg, form.nuDeg],
    });
    if (message) throw new Error(message);
  }

  // フォームの placementMode に応じた妥当性検証を行う。不正なら理由付きで例外を投げる。
  private assertValidForm(form: ShipPlacerForm): void {
    if (form.placementMode === 'elements') {
      this.assertValidElementsForm(form);
      return;
    }
    const values = [form.axKm, form.azKm];
    if (!values.every(Number.isFinite) || form.azKm <= 0 || (form.lagrangeOrbitKind === 'lissajous' && form.axKm <= 0)) {
      throw new Error('ラグランジュ軌道の振幅には有限の正数を入力してください');
    }
  }

  private assertFiniteEllipticState(state: KinematicState): void {
    const values = [state.r.x, state.r.y, state.r.z, state.v.x, state.v.y, state.v.z];
    if (!values.every(Number.isFinite)) throw new Error('有限の状態を作れませんでした');
  }

  // 通常ステージと同じ残弾監視・回収・遠方補給の再投入を行い、配置プレビューを求め直す。
  // 計画ノードの適用は Simulator のイベント境界(applySimulationEvents)で行う。
  update(_dt: number, player: Player | null, _entities: EntityManager, simTime: number, _simSpeed: SimSpeedManager): void {
    if (player) this.logistics.updateLogistics(simTime, player, true);
    this.preview = this.computePreview();
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

  // ステージ固有の補助メッセージは無いが、null を返すと StageStatusPanel 自体が非表示になるので、
  // 装甲・エンジン出力・温度・電力の表示のためだけに空文字を返す。
  hudSubStatus(): string {
    return '';
  }
}
