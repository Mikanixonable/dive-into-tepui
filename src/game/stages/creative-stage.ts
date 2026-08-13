// クリエイティブモード: 勝敗判定を発生させず、艦艇配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage, type ObjectAuthoring, type StageDeps } from './stage';
import { Player } from '../player/player';
import { EntityIdAllocator } from '../game-entity/entity-id';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, semiMajorFromPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { Attractor, orbitalElementsOf } from '../../physics/attractor';
import { haloState, lissajousState } from '../../physics/halo';
import type { FloatingOrigin } from '../floating-origin';
import { Vec3, add } from '../../physics/vec3';
import { ToggleSwitch } from '../hud/widgets';
import { hudDock } from '../hud/dom';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import { Ammo } from '../game-entity/ammo';
import { Base } from '../game-entity/base';
import { generateDriftingEnemy } from './spawner/enemy-generator';
import { WaveAttack } from './stage-utils/wave-attack';
import * as C from '../const';
import { ElementsForm, LagrangeForm, ObjectType, ReferenceAttractor, ShipPlacerForm, ShipPlacerPanel } from '../creative/ship-placer-panel';
import { validateEllipticPlacementFields, validateBaseReferenceFields, validateLagrangePlacementFields, PlacementFieldIssue } from '../creative/placement-validation';
import { elementsFormFromState } from '../creative/duplicate-form';
import { OrbitLine } from '../orbit-line';
import type { MapVisibilityPolicy } from '../celestial/map-visibility';
import type { CreativeStageSaveData, StageSaveData } from '../save-data';

const DEG = Math.PI / 180;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  // 艦は0隻から始まり、配置パネルで随時追加する(艦0..n隻が一般形で、これはその上限が
  // 無い側の特殊化にすぎない)。
  static readonly initialPlayerCount = 0;
  static readonly showsStatusInOverview = true;
  static readonly selectLabel = 'CREATIVE';
  static readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  static readonly selectGroup = 'クリエイティブモード';
  static readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };
  readonly freeProcurement = true;
  readonly executesPlans = true;
  readonly authoring: ObjectAuthoring = this;

  private readonly placerPanel: ShipPlacerPanel;
  // 補給の自動投入・敵の波状攻撃を切り替えるトグルを載せたパネル。マップ視点でだけ出す。
  private readonly creativeSettingsPanel: HTMLElement;
  private readonly waveAttack: WaveAttack;
  // 敵の波状攻撃を発生させるかどうか。既定 OFF — ON の間だけ update が WaveAttack を進める。
  private waveAttackEnabled: boolean;
  private readonly previewOrbitLine: OrbitLine;
  // 艦艇配置パネルのフォーム値から求めた配置プレビュー。出すものが無ければ null。
  private preview: { readonly elements: OrbitalElements; readonly pos: Vec3 } | null = null;
  // 現在のフォーム値に対するフィールド単位の検証結果。パネルが閉じている間は空。
  private issues: readonly PlacementFieldIssue[] = [];
  // 噴射の可否を substep 境界でも問い合わせられるよう、update() が受け取る参照を保持する
  // (値ではなく参照なので、境界での読み取りは常にその時点の時間加速段を反映する)。
  private simSpeed: SimSpeedManager | null = null;
  private readonly playerIdAllocator = new EntityIdAllocator('creative-player-');
  private readonly ammoIdAllocator = new EntityIdAllocator('creative-ammo-');
  // フォールバック名(Player-N 等)の連番。id とは独立(同名は許容する)。
  private nextFallbackNameSeq = 1;

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    const savedCreative = saved as CreativeStageSaveData | undefined;

    // 以後の新規配置が既存 id と衝突しないよう、この時点で存在する艦・補給の id を予約する
    // (スナップショットからの再開では entities が復元済み — 新規開始では空なので何もしない)。
    for (const p of this._entities.players) this.playerIdAllocator.next(p.id);
    for (const a of this._entities.ammos) this.ammoIdAllocator.next(a.id);

    this.previewOrbitLine = new OrbitLine(0xffffff, 0.6, C.LINE_RENDER_ORDER.plan);
    this._scene.add(this.previewOrbitLine.line);

    this.placerPanel = new ShipPlacerPanel(
      this._hud.layers.panel, this._hud.layers.popup, this._ephemeris, this._hud.overlayManager,
    );
    this.placerPanel.onConfirm = (name, form) => this.placeObject(name, form);
    this.waveAttack = new WaveAttack(this._hud, this._sfx, this._fx, this._scene, this._ephemeris, savedCreative?.waveAttack);
    this.waveAttackEnabled = savedCreative?.waveAttackEnabled ?? false;
    this.creativeSettingsPanel = this.buildCreativeSettingsPanel(this._hud.layers.panel);

    this.begin();
  }

  // 補給の自動投入・敵の波状攻撃のトグルを載せたパネルを組み立て、マップ右ドックへ追加して返す。
  private buildCreativeSettingsPanel(hudRoot: HTMLElement): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'hud-creative-settings';
    panel.className = 'panel';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '設定';
    panel.appendChild(title);
    const resupplyToggle = new ToggleSwitch('補給の自動投入', (on) => { this.logistics.resupplyEnabled = on; });
    resupplyToggle.setOn(this.logistics.resupplyEnabled);
    panel.appendChild(resupplyToggle.element);
    const waveAttackToggle = new ToggleSwitch('敵の波状攻撃', (on) => { this.waveAttackEnabled = on; });
    waveAttackToggle.setOn(this.waveAttackEnabled);
    panel.appendChild(waveAttackToggle.element);
    hudDock(hudRoot, 'right').appendChild(panel);
    return panel;
  }

  // 共通のステータス表示に加えて、配置プレビューの軌道線とマーカーを同期する。
  sync(
    player: Player | null, fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, displayTime: number,
    overviewMode: boolean, visibilityPolicy: MapVisibilityPolicy | null, camera: THREE.Camera,
  ): void {
    super.sync(player, fo, project, scale, displayTime, overviewMode, visibilityPolicy, camera);
    this.syncPreview(fo, project, camera);
    this.placerPanel.setIssues(this.issues);
    this.creativeSettingsPanel.style.display = overviewMode ? 'block' : 'none';
  }

  // 艦艇配置モーダルを開く (MapPicker から呼ばれる)。focusId はマップの現在フォーカスで、
  // 基準天体になれる ID なら基準天体の初期選択に使う。
  openShipPlacer(focusId?: string): void {
    this.placerPanel.open(focusId !== undefined ? { kind: 'body', attractor: focusId as ReferenceAttractor } : undefined);
  }

  // 右クリックメニューの「複製」(MapPicker から呼ばれる)。state を軌道要素へ逆算でき、
  // かつ基地の基準天体制約(validateBaseReferenceFields — 月基準かラグランジュ点のみ)を
  // 満たす値が求まったときだけ、その値をプリセットして開く。逆算できない状態(双曲線軌道など)や、
  // 基地なのに基準天体が月でない(地球が支配的な複製元など)ときは、値だけを引き継ぐと
  // 制約に反した軌道が黙って配置できてしまうので、種類だけを引き継いで通常の新規配置として開く。
  openShipPlacerForDuplicate(objectType: ObjectType, state: KinematicState): void {
    const attractors = this._ephemeris.attractorsAt(this._simulator.simTime);
    const form = elementsFormFromState(state, attractors, this._ephemeris.originId);
    if (form && validateBaseReferenceFields(objectType, 'elements', form.attractor).length === 0) {
      this.placerPanel.open({ kind: 'form', objectType, form });
      return;
    }
    this._hud.hint('この軌道は要素として複製できないため、種類だけを引き継いだ新規配置として開きます');
    this.placerPanel.open({ kind: 'objectType', objectType });
  }

  // フォーム値から配置プレビューの軌道要素と位置を求める。軌道要素指定以外の配置方法・
  // 入力を解釈できない値のときは null(プレビューを出さない)。
  private computePreview(form: ShipPlacerForm): { elements: OrbitalElements; pos: Vec3 } | null {
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

  // フォーム値をフィールド単位で検証する。assertValidForm(確定時、最初の問題で例外を投げる)と
  // 同じ検証呼び出しを共有し、両者が食い違うことを防ぐ。
  private computeFieldIssues(form: ShipPlacerForm): PlacementFieldIssue[] {
    const issues = [...validateBaseReferenceFields(
      form.objectType, form.placementMode, form.placementMode === 'elements' ? form.attractor : undefined,
    )];
    if (form.placementMode === 'elements') {
      const center = this.referenceAttractor(form);
      const common = {
        centerRadius: center.radius, mu: center.mu,
        incDeg: form.incDeg, raanDeg: form.raanDeg, argpDeg: form.argpDeg, nuDeg: form.nuDeg,
      };
      issues.push(...validateEllipticPlacementFields(
        form.sizeMode === 'apsides' ? { ...common, sizeMode: 'apsides', peAltKm: form.peAltKm, apAltKm: form.apAltKm }
        : form.sizeMode === 'semiMajorEcc'
          ? { ...common, sizeMode: 'semiMajorEcc', semiMajorKm: form.semiMajorKm, eccentricity: form.eccentricity }
          : { ...common, sizeMode: 'periodEcc', periodHours: form.periodHours, eccentricity: form.eccentricity },
      ));
    } else {
      issues.push(...validateLagrangePlacementFields(
        form.lagrangeOrbitKind === 'halo'
          ? { orbitKind: 'halo', outOfPlaneAmplitudeKm: form.azKm }
          : { orbitKind: 'lissajous', inPlaneAmplitudeKm: form.axKm, outOfPlaneAmplitudeKm: form.azKm },
      ));
    }
    return issues;
  }

  // 配置プレビューの軌道線と ▷ マーカーを update が求めた値へ同期する。
  private syncPreview(fo: FloatingOrigin, project: ProjectFn, camera: THREE.Camera): void {
    if (!this.preview) {
      this.previewOrbitLine.sync(null, fo, camera);
      this._markerManager.hide('creative-preview');
      return;
    }
    this.previewOrbitLine.sync(this.preview.elements, fo, camera, true);
    this._markerManager.setPosition(
      'creative-preview', 'mk-self', ENTITY_GLYPH.preview, this.preview.pos, project,
      'PREVIEW', 1, C.COLOR_MARKER_ALLY, 0, false, false,
    );
  }

  // フォーム値から KinematicState を組み立て、配置する。
  private placeObject(name: string, form: ShipPlacerForm): void {
    if (form.objectType === 'player' && this._entities.players.length >= C.MAX_PLACED_SHIPS) {
      this._hud.hint(`配置数が上限(${C.MAX_PLACED_SHIPS}隻)に達しています`);
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      
      if (form.objectType === 'player') {
        const id = this.playerIdAllocator.next();
        const finalName = name || `Player-${this.nextFallbackNameSeq++}`;
        const ship = new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, { name: finalName, state, id });
        this._entities.addPlayer(ship);
        this._activePlayers.claimIfNone(ship);
        this._hud.hint(`${ship.name} を配置`);
      } else if (form.objectType === 'enemy') {
        const finalName = name || `Enemy-${this.nextFallbackNameSeq++}`;
        const enemy = generateDriftingEnemy(finalName, state, C.ENEMY_MAX_HP, '#ff6a00', '#ff6a00', this._hud, this._sfx, this._fx, this._scene);
        this._entities.addEnemy(enemy);
        this._hud.hint(`${enemy.name} を配置`);
      } else if (form.objectType === 'ammo') {
        const id = this.ammoIdAllocator.next();
        const ammo = new Ammo({ state, id }, this._scene, this._markerManager);
        this._entities.addAmmo(ammo);
        const finalName = name || `Ammo-${this.nextFallbackNameSeq++}`;
        this._hud.hint(`${finalName} を配置`);
      } else if (form.objectType === 'base') {
        const finalName = name || `Base-${this.nextFallbackNameSeq++}`;
        const base = new Base({ state, name: finalName }, this._scene, this._hud, this._sfx, this._fx, this._markerManager);
        this._entities.addBase(base);
        this._hud.hint(`${base.name} を配置`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '入力を解釈できません';
      this._hud.hint(`配置できません: ${message}`, 5000);
    }
  }

  // フォームの placementMode に応じて軌道要素指定(stateFromOrbitalElements)かラグランジュ点指定
  // (haloState/lissajousState)のどちらかで KinematicState を組み立てる。
  private buildInitialState(form: ShipPlacerForm): KinematicState {
    if (form.placementMode === 'lagrange') return this.buildLagrangeState(form);
    return this.buildElementsState(form);
  }

  // 副天体・点・軌道種別・振幅から、ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。
  // ハローの面内振幅は三次の振幅拘束で面外振幅から決まるので、フォーム自体に面内振幅の値がない。
  private buildLagrangeState(form: LagrangeForm): KinematicState {
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
  private referenceAttractor(form: ElementsForm): Attractor {
    return this._ephemeris.attractorsAt(this._simulator.simTime).find((b) => b.id === form.attractor)!;
  }

  // フォームが選んだサイズ/形の組から長半径・離心率を導出し、要素→状態変換
  // (stateFromOrbitalElements)で基準天体中心の相対状態を組んでから、基準天体自身の位置・速度を
  // 足して ECI 化する(地球基準では位置・速度とも厳密に 0 なので、実質そのまま返る)。
  private buildElementsState(form: ElementsForm): KinematicState {
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

  // フォームの値が物理的に成立するか検証する。computeFieldIssues と同じ検証呼び出しを共有し、
  // 不正なら最初の問題を理由に例外を投げる。
  private assertValidForm(form: ShipPlacerForm): void {
    const [firstIssue] = this.computeFieldIssues(form);
    if (firstIssue) throw new Error(firstIssue.message);
  }

  private assertFiniteEllipticState(state: KinematicState): void {
    const values = [state.r.x, state.r.y, state.r.z, state.v.x, state.v.y, state.v.z];
    if (!values.every(Number.isFinite)) throw new Error('有限の状態を作れませんでした');
  }

  // 通常ステージと同じ残弾監視・回収・遠方補給の再投入を行い、配置プレビューとフォームの
  // フィールド単位の検証結果を求め直す。'powered' な艦の姿勢整列・出力段選択も全艦ぶん進める
  // (操作対象艦に限らない — Player.behave は操作対象艦でしか走らないため)。
  // 既存敵の AI 行動は常に進める。トグルが制御するのは新規ウェーブの発生のみ
  // (OFF の間は waveAttack.update を止め、既に出ている敵はそのまま残る)。
  // ノードの消化・点火・遮断は Simulator のイベント境界(applySimulationEvents)で行う。
  update(dt: number, player: Player | null, _entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (player) {
      this.logistics.updateLogistics(simTime, player, simSpeed, true);
      this.behaveAllEnemies(dt, player, this._entities, simTime, simSpeed);
      if (this.waveAttackEnabled) {
        this.waveAttack.update(dt, player, this._entities.enemies, simTime, this, (enemy) => this.addEnemy(enemy, this._entities));
      }
    }
    const form = this.placerPanel.isOpen ? this.placerPanel.getForm() : null;
    this.preview = form ? this.computePreview(form) : null;
    this.issues = form ? this.computeFieldIssues(form) : [];
    this.simSpeed = simSpeed;
    for (const ship of this._entities.players) ship.planExecutor.update(ship, dt, simTime, simSpeed);
  }

  // 'instant' の艦はノード時刻ちょうど、'powered' の艦は点火予定時刻を Simulator の既知
  // イベントとして返し、simTime がその時刻ちょうどで積分を切るようにする。
  nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._entities.players) {
      const t = ship.planExecution === 'instant' ? ship.plan.firstNode()?.t
        : ship.planExecution === 'powered' && this.simSpeed
          ? (ship.planExecutor.nextEventTime(ship, simTime, this.simSpeed) ?? undefined)
        : undefined;
      if (t !== undefined && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  // 'instant' はノード時刻ちょうどでノードの絶対状態へ乗り移り、'powered' は PlanExecutor に
  // 点火・遮断そのものを委ねる。
  applySimulationEvents(simTime: number): void {
    for (const ship of this._entities.players) {
      if (ship.planExecution === 'instant') {
        const node = ship.plan.firstNode();
        if (!node || node.t > simTime + 1e-9) continue;
        // 瞬間移動では、消化する最後のノードの絶対状態がそのまま到達状態になる(誤差が無い)。
        const nodes = ship.plan.nodes;
        let reached: KinematicState | undefined;
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          if (n && n.t <= simTime) { reached = n; break; }
        }
        if (!reached) continue;
        ship.plan.consumeNodesUpTo(simTime, reached);
        ship.state = reached;
      } else if (ship.planExecution === 'powered' && this.simSpeed) {
        ship.planExecutor.applyIgnitionAndCutoff(ship, simTime, this.simSpeed);
      }
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

  serialize(): CreativeStageSaveData {
    return {
      ...super.serialize(),
      waveAttackEnabled: this.waveAttackEnabled,
      waveAttack: this.waveAttack.serialize(),
    };
  }
}
