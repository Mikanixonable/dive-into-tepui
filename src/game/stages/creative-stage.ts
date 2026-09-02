// クリエイティブモード: 勝敗判定を発生させず、物体配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage, type ObjectAuthoring, type StageDeps, STORY_EPOCH } from './stage';
import type { Player } from '../player/player';
import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, semiMajorFromPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { CelestialMotion } from '../../physics/celestial-motion';
import { orbitalElementsOf } from '../../physics/elements';
import { haloState, lissajousState } from '../../physics/halo';
import { secondaryFrameOf } from '../../physics/lagrange';
import { OrbitingMotion } from '../../physics/celestial-motion';
import type { FloatingOrigin } from '../camera/floating-origin';
import { qRotate } from '../../physics/attitude';
import { Vec3, add, addScaled, v3 } from '../../math/vec3';
import { isOccluded } from '../../physics/occlusion';
import { hudRail } from '../hud/hud-root';
import type { CameraSystem, ProjectFn } from '../camera/camera-system';
import { AmmoPickup } from '../dynamic/dynamic-entity/ammo-pickup';
import { RcsFuelPickup } from '../dynamic/dynamic-entity/rcs-fuel-pickup';
import { Base } from '../dynamic/dynamic-entity/base';
import { generateApproachingEnemy, generateDriftingEnemy, generateProteinEnemy, proteinFormationSpawns } from './spawner/enemy-generator';
import { DEFAULT_PROTEIN_DISPLAY, type ProteinDisplaySettings } from '../protein/protein-display';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { WaveAttack } from './stage-utils/wave-attack';
import { generateRandomName } from '../random-name';
import { ElementsForm, LagrangeForm, ReferenceCelestialBody, ObjectPlacerForm, ObjectPlacerPanel } from '../creative/object-placer-panel';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import { validateEllipticPlacementFields, validateBaseReferenceFields, validateLagrangePlacementFields, PlacementFieldIssue } from '../creative/placement-validation';
import { elementsFormFromState } from '../creative/duplicate-form';
import { STAGE_CONTROL_ENEMY_SHAPES, StageControlsPanel, type EnemySpawnShape } from '../creative/stage-controls-panel';
import { EllipseLine } from '../lines/ellipse-line';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CreativeStageSaveData, StageSaveData } from '../save/save-data';

// 軌道上へ配置できる自機の上限隻数。
const MAX_PLACED_SHIPS = 50;

const DEG = Math.PI / 180;

const STAGE_CONTROL_DEFAULT_ENEMY_SPAWN_DISTANCE = 2000;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  static readonly epoch = STORY_EPOCH;
  // 開始日時の指定画面を挟む唯一のステージ(GAME.md 9.0)。epoch はその欄の既定値になる。
  static readonly picksStartEpoch = true;
  static readonly selectLabel = 'CREATIVE';
  static readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  static readonly selectGroup = 'クリエイティブモード';
  static readonly selectKeys: string[] = [];
  readonly freeProcurement = true;
  readonly executesPlans = true;
  readonly authoring: ObjectAuthoring = this;

  private readonly placerPanel: ObjectPlacerPanel;
  // 補給の自動投入・敵の波状攻撃を切り替えるトグルを載せたパネル。マップ視点でだけ出す。
  private readonly stageControlsPanel: StageControlsPanel;
  private readonly waveAttack: WaveAttack;
  // 敵の波状攻撃を発生させるかどうか。既定 OFF — ON の間だけ update が WaveAttack を進める。
  private waveAttackEnabled: boolean;
  private readonly previewEllipseLine: EllipseLine;
  // 物体配置パネルのフォーム値から求めた配置プレビュー。出すものが無ければ null。
  private preview: { readonly elements: OrbitalElements; readonly pos: Vec3 } | null = null;
  // 現在のフォーム値に対するフィールド単位の検証結果。パネルが閉じている間は空。
  private issues: readonly PlacementFieldIssue[] = [];
  private readonly playerIdAllocator = new EntityIdAllocator('creative-player-');
  private readonly ammoPickupIdAllocator = new EntityIdAllocator('creative-ammo-');
  private readonly rcsFuelPickupIdAllocator = new EntityIdAllocator('creative-rcs-fuel-');
  private activePlayer: Player | null = null;
  private manualEnemyCount = 0;
  private manualFormationCount = 0;
  private manualEnemySpawnDistance = STAGE_CONTROL_DEFAULT_ENEMY_SPAWN_DISTANCE;
  // 手動スポーンで使うタンパク質の表示設定。ステージ操作パネルの選択と onProteinDisplayChange で同期する。
  private proteinDisplay: ProteinDisplaySettings = DEFAULT_PROTEIN_DISPLAY;

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // saved の型を StageSaveData に留めるのは stage.ts の StageClass 一覧に
  // 収める都合(具象ごとの拡張型では構築シグネチャが揃わない)。
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    const savedCreative = saved as CreativeStageSaveData | undefined;

    // 以後の新規配置が既存 id と衝突しないよう、この時点で存在する艦・補給の id を予約する
    // (スナップショットからの再開では entities が復元済み — 新規開始では空なので何もしない)。
    for (const p of this._entities.players) this.playerIdAllocator.next(p.id);
    for (const ammoPickup of this._entities.ammoPickups) this.ammoPickupIdAllocator.next(ammoPickup.id);
    for (const pickup of this._entities.rcsFuelPickups) this.rcsFuelPickupIdAllocator.next(pickup.id);
    const restoredProtein = this._entities.enemies.find((enemy) => enemy instanceof ProteinEnemy);
    if (restoredProtein) this.proteinDisplay = restoredProtein.display;

    this.previewEllipseLine = new EllipseLine({ color: 0xffffff, opacity: 0.6, renderOrder: LINE_RENDER_ORDER.plan });
    this._scene.add(this.previewEllipseLine.line);

    this.placerPanel = new ObjectPlacerPanel(
      this._hud.mapRoot, this._hud.layers.popup, this._celestialSystem, this._hud.overlayManager,
    );
    this.placerPanel.onConfirm = (name, form) => this.placeObject(name, form);
    this.waveAttack = new WaveAttack(this._hud, this._worldSfx, this._fx, this._scene, this._celestialSystem, savedCreative?.waveAttack);
    this.waveAttackEnabled = savedCreative?.waveAttackEnabled ?? false;
    this.stageControlsPanel = new StageControlsPanel(
      this.logistics.resupplyEnabled, this.logistics.rcsFuelResupplyEnabled, this.waveAttackEnabled,
      this.manualEnemySpawnDistance, this.proteinDisplay,
    );
    this.stageControlsPanel.onToggleResupply = (on) => { this.logistics.resupplyEnabled = on; };
    this.stageControlsPanel.onToggleFuelResupply = (on) => { this.logistics.rcsFuelResupplyEnabled = on; };
    this.stageControlsPanel.onToggleWaveAttack = (on) => { this.waveAttackEnabled = on; };
    this.stageControlsPanel.onRefillAmmo = () => this.refillActivePlayerAmmo();
    this.stageControlsPanel.onRefillFuel = () => this.refillActivePlayerRcsFuel();
    this.stageControlsPanel.onSpawnDistanceChange = (distance) => { this.manualEnemySpawnDistance = distance; };
    this.stageControlsPanel.onSpawnEnemy = (shape, colorValue) => this.spawnManualEnemy(shape, colorValue);
    this.stageControlsPanel.onSpawnFormation = () => this.spawnProteinFormation();
    this.stageControlsPanel.onProteinDisplayChange = (display) => {
      this.proteinDisplay = display;
      this.applyProteinDisplay(display);
    };
    hudRail(this._hud.mapRoot, 'right').appendChild(this.stageControlsPanel.element);

    this.begin();
  }

  private applyProteinDisplay(display: ProteinDisplaySettings): void {
    for (const enemy of this._entities.enemies) {
      if (enemy instanceof ProteinEnemy) enemy.setDisplay(display);
    }
  }

  private refillActivePlayerAmmo(): void {
    const player = this.activePlayer;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため弾薬を補充できません');
      return;
    }
    player.refillAmmo();
  }

  private refillActivePlayerRcsFuel(): void {
    const player = this.activePlayer;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないためRCS燃料を補充できません');
      return;
    }
    player.refuelFuel(player.totalMaxFuel);
  }

  private spawnManualEnemy(shape: EnemySpawnShape, colorValue: string): void {
    const player = this.activePlayer;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため敵をスポーンできません');
      return;
    }
    const color = Number(colorValue);
    const forward = qRotate(player.att.q, v3(0, 0, 1));
    const position = addScaled(player.state.r, forward, this.manualEnemySpawnDistance);
    const state = kinematicState<'eci'>(player.state.t, position, player.state.v);
    const name = `MANUAL-${++this.manualEnemyCount}`;
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return;
    if (shapeDefinition.kind === 'drifting') {
      this.addEnemy(generateDriftingEnemy(name, state, color, color, this._worldSfx, this._fx, this._scene), this._entities);
      return;
    }
    if (shapeDefinition.kind === 'protein') {
      this.spawnEnemyWhenReady(
        shapeDefinition.assetId,
        () => generateProteinEnemy(name, state, shapeDefinition.assetId, this.proteinDisplay, this._worldSfx, this._fx, this._scene),
        this._entities,
      );
      return;
    }
    this.addEnemy(generateApproachingEnemy(
      name, state, color, color, shapeDefinition.typeIndex, undefined,
      this._worldSfx, this._fx, this._scene,
    ), this._entities);
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機前方に一括スポーンする。
  private spawnProteinFormation(): void {
    const player = this.activePlayer;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため敵をスポーンできません');
      return;
    }
    const forward = qRotate(player.att.q, v3(0, 0, 1));
    const position = addScaled(player.state.r, forward, this.manualEnemySpawnDistance);
    const state = kinematicState<'eci'>(player.state.t, position, player.state.v);
    const name = `FORMATION-${++this.manualFormationCount}`;
    const formationId = name;
    for (const { assetId, build } of proteinFormationSpawns(name, state, player.state.r, this.proteinDisplay, formationId, this._worldSfx, this._fx, this._scene)) {
      this.spawnEnemyWhenReady(assetId, build, this._entities);
    }
  }

  // ステージ操作パネルは、表示中のワールドビューの右ドックへ追従させる。
  private mountStageControlsPanel(inMapView: boolean): void {
    const root = inMapView ? this._hud.mapRoot : this._hud.combatRoot;
    const rightRail = hudRail(root, 'right');
    if (this.stageControlsPanel.element.parentElement === rightRail) return;
    const vessel = rightRail.querySelector<HTMLElement>('#hud-vessel-status');
    if (vessel !== null) rightRail.insertBefore(this.stageControlsPanel.element, vessel);
    else rightRail.appendChild(this.stageControlsPanel.element);
  }

  // 共通のステータス表示に加えて、配置プレビューの軌道線とマーカーを同期する。
  sync(
    player: Player | null, fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    super.sync(player, fo, cameraSystem, displayTime, visibilityPolicy);
    this.activePlayer = player;
    this.stageControlsPanel.setSpawnButtonsEnabled(player !== null && player.alive);
    this.mountStageControlsPanel(cameraSystem.worldView === 'map');
    this.syncPreview(
      fo, cameraSystem.activeCameraProjection, cameraSystem.activeCamera,
      cameraSystem.worldView === 'map', cameraSystem.activeCameraPos,
      this._celestialSystem.celestialMotions, displayTime,
    );
    this.placerPanel.setIssues(this.issues);
    this.stageControlsPanel.element.classList.remove('hidden');
  }

  // オブジェクト配置モーダルを開く (MapContextActions から呼ばれる)。focusId はマップの現在フォーカスで、
  // 基準天体になれる ID なら基準天体の初期選択に使う。
  openObjectPlacer(focusId?: string): void {
    this.placerPanel.open(focusId !== undefined ? { kind: 'body', celestialBody: focusId as ReferenceCelestialBody } : undefined);
  }

  // 右クリックメニューの「複製」(MapContextActions から呼ばれる)。state を軌道要素へ逆算でき、
  // かつ基地の基準天体制約(validateBaseReferenceFields — 月基準かラグランジュ点のみ)を
  // 満たす値が求まったときだけ、その値をプリセットして開く。逆算できない状態(双曲線軌道など)や、
  // 基地なのに基準天体が月でない(地球が支配的な複製元など)ときは、値だけを引き継ぐと
  // 制約に反した軌道が黙って配置できてしまうので、種類だけを引き継いで通常の新規配置として開く。
  openObjectPlacerForDuplicate(entityKind: DynamicEntityKind, state: KinematicState): void {
    const form = elementsFormFromState(
      state, this._celestialSystem, state.t, this._celestialSystem.origin.id);
    if (form && validateBaseReferenceFields(entityKind, 'elements', form.celestialBody).length === 0) {
      this.placerPanel.open({ kind: 'form', entityKind, form });
      return;
    }
    this._hud.hint('この軌道は要素として複製できないため、種類だけを引き継いだ新規配置として開きます');
    this.placerPanel.open({ kind: 'entityKind', entityKind });
  }

  // フォーム値から配置プレビューの軌道要素と位置を求める。軌道要素指定以外の配置方法・
  // 入力を解釈できない値のときは null(プレビューを出さない)。
  private computePreview(form: ObjectPlacerForm): { elements: OrbitalElements; pos: Vec3 } | null {
    if (form.placementMode !== 'elements') return null;
    try {
      const state = this.buildInitialState(form);
      // 楕円はフォームが選んだ基準天体中心で描く。
      const elements = orbitalElementsOf(state, this.referenceCelestialBody(form), state.t);
      return elements ? { elements, pos: state.r } : null;
    } catch {
      return null;
    }
  }

  // フォーム値をフィールド単位で検証する。assertValidForm(確定時、最初の問題で例外を投げる)と
  // 同じ検証呼び出しを共有し、両者が食い違うことを防ぐ。
  private computeFieldIssues(form: ObjectPlacerForm): PlacementFieldIssue[] {
    const issues = [...validateBaseReferenceFields(
      form.entityKind, form.placementMode, form.placementMode === 'elements' ? form.celestialBody : undefined,
    )];
    if (form.placementMode === 'elements') {
      const center = this.referenceCelestialBody(form);
      const common = {
        centerRadius: center.def.radius, mu: center.def.mu, centerId: center.id,
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
  private syncPreview(
    fo: FloatingOrigin, project: ProjectFn, camera: THREE.Camera,
    mapView: boolean, cameraPos: Vec3, celestialBodies: readonly CelestialMotion[],
    displayTime: number,
  ): void {
    if (!this.preview) {
      this.previewEllipseLine.hide();
      this._markerManager.fadeOut('creative-preview');
      return;
    }
    this.previewEllipseLine.sync(this.preview.elements, fo, camera);
    if (mapView
      && isOccluded(cameraPos, this.preview.pos, celestialBodies, displayTime)) {
      this._markerManager.hide('creative-preview');
      return;
    }
    this._markerManager.setPosition(
      'creative-preview', 'mk-self', ENTITY_GLYPH.preview, this.preview.pos, project,
      'PREVIEW', 1, COLOR_MARKER_ALLY, 0, false, false, undefined, cameraPos,
    );
  }

  // フォーム値から KinematicState を組み立て、配置する。
  private placeObject(name: string, form: ObjectPlacerForm): void {
    if (form.entityKind === 'player' && this._entities.players.length >= MAX_PLACED_SHIPS) {
      this._hud.hint(`配置数が上限(${MAX_PLACED_SHIPS}隻)に達しています`);
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      
      if (form.entityKind === 'player') {
        const id = this.playerIdAllocator.next();
        const finalName = name.trim() || generateRandomName('player');
        const ship = this.addPlayer({ name: finalName, state, id });
        this._hud.hint(`${ship.name} を配置`);
      } else if (form.entityKind === 'enemy') {
        const finalName = name.trim() || generateRandomName('enemy');
        const enemy = generateDriftingEnemy(finalName, state, '#ff6a00', '#ff6a00', this._worldSfx, this._fx, this._scene);
        this._entities.addEnemy(enemy);
        this._hud.hint(`${enemy.name} を配置`);
      } else if (form.entityKind === 'ammo') {
        const id = this.ammoPickupIdAllocator.next();
        const ammoPickup = new AmmoPickup({ state, id }, this._scene);
        this._entities.addAmmoPickup(ammoPickup);
        const finalName = name.trim() || generateRandomName('ammo');
        this._hud.hint(`${finalName} を配置`);
      } else if (form.entityKind === 'fuel') {
        const id = this.rcsFuelPickupIdAllocator.next();
        const pickup = new RcsFuelPickup({ state, id }, this._scene);
        this._entities.addRcsFuelPickup(pickup);
        const finalName = name.trim() || generateRandomName('fuel');
        pickup.name = finalName;
        this._hud.hint(`${finalName} を配置`);
      } else if (form.entityKind === 'base') {
        const finalName = name.trim() || generateRandomName('base');
        const base = new Base({ state, name: finalName }, this._scene, this._hud, this._worldSfx, this._fx, this._markerManager);
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
  private buildInitialState(form: ObjectPlacerForm): KinematicState {
    if (form.placementMode === 'lagrange') return this.buildLagrangeState(form);
    return this.buildElementsState(form);
  }

  // 副天体・点・軌道種別・振幅から、ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。
  // ハローの面内振幅は三次の振幅拘束で面外振幅から決まるので、フォーム自体に面内振幅の値がない。
  private buildLagrangeState(form: LagrangeForm): KinematicState {
    const motion = this._celestialSystem.entityOf(form.lagrangeSecondary).motion;
    if (!(motion instanceof OrbitingMotion)) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} は公転していないのでラグランジュ点を持たない`);
    }
    const t = this._simulator.simTime;
    const system = secondaryFrameOf(this._celestialSystem.celestialMotions, t, motion, t);
    if (system === null) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} の主天体が引けない`);
    }
    if (form.lagrangeOrbitKind === 'halo') {
      return haloState(system, { point: form.lagrangePoint, az: form.azKm * 1e3 });
    }
    return lissajousState(system, { point: form.lagrangePoint, ax: form.axKm * 1e3, az: form.azKm * 1e3 });
  }

  // フォームの基準天体(地球 or 月)を、その時刻の重力源として引く。μ・半径・ECI 化に
  // 要る情報がすべてここから出る。
  private referenceCelestialBody(form: ElementsForm): CelestialMotion {
    return this._celestialSystem.motionOf(form.celestialBody);
  }

  // フォームが選んだサイズ/形の組から長半径・離心率を導出し、要素→状態変換
  // (stateFromOrbitalElements)で基準天体中心の相対状態を組んでから、基準天体自身の位置・速度を
  // 足して ECI 化する(地球基準では位置・速度とも厳密に 0 なので、実質そのまま返る)。
  private buildElementsState(form: ElementsForm): KinematicState {
    const center = this.referenceCelestialBody(form);
    const centerState = center.stateAt(this._simulator.simTime);
    let a: number;
    let e: number;
    if (form.sizeMode === 'apsides') {
      const rp = center.def.radius + form.peAltKm * 1e3;
      const ra = center.def.radius + form.apAltKm * 1e3;
      a = (rp + ra) / 2;
      e = (ra - rp) / (ra + rp);
    } else if (form.sizeMode === 'semiMajorEcc') {
      a = form.semiMajorKm * 1e3;
      e = form.eccentricity;
    } else {
      a = semiMajorFromPeriod(form.periodHours * 3600, center.def.mu);
      e = form.eccentricity;
    }

    const rel = stateFromOrbitalElements(
      this._simulator.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG,
      form.nuDeg * DEG, center.def.mu,
    );
    return kinematicState<'eci'>(
      this._simulator.simTime, add(centerState.r, rel.r), add(centerState.v, rel.v));
  }

  // フォームの値が物理的に成立するか検証する。computeFieldIssues と同じ検証呼び出しを共有し、
  // 不正なら最初の問題を理由に例外を投げる。
  private assertValidForm(form: ObjectPlacerForm): void {
    const [firstIssue] = this.computeFieldIssues(form);
    if (firstIssue) throw new Error(firstIssue.message);
  }

  private assertFiniteEllipticState(state: KinematicState): void {
    const values = [state.r.x, state.r.y, state.r.z, state.v.x, state.v.y, state.v.z];
    if (!values.every(Number.isFinite)) throw new Error('有限の状態を作れませんでした');
  }

  // 通常ステージと同じ残弾監視・回収・遠方補給の再投入を行い、配置プレビューとフォームの
  // フィールド単位の検証結果を求め直す。既存敵の AI 行動は常に進める。トグルが制御するのは
  // 新規ウェーブの発生のみ(OFF の間は waveAttack.update を止め、既に出ている敵はそのまま残る)。
  // ノードの消化は Simulator のイベント境界(applySimulationEvents)で行う。
  update(dt: number, player: Player | null, _entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void {
    if (player) {
      this.logistics.updateLogistics(simTime, player, simSpeed, true);
      this.behaveAllEnemies(player, this._entities, simTime, simSpeed);
      if (this.waveAttackEnabled) {
        this.waveAttack.update(dt, player, this._entities.enemies, simTime, this, (enemy) => this.addEnemy(enemy, this._entities));
      }
    }
    const form = this.placerPanel.isOpen ? this.placerPanel.getForm() : null;
    this.preview = form ? this.computePreview(form) : null;
    this.issues = form ? this.computeFieldIssues(form) : [];
  }

  // 'instant' の艦のノード時刻ちょうどを Simulator の既知イベントとして返し、simTime が
  // その時刻ちょうどで積分を切るようにする。
  nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._entities.players) {
      const t = ship.planExecution === 'instant' ? ship.plan.firstNode()?.t : undefined;
      if (t !== undefined && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  // ノード時刻ちょうどでノードの絶対状態へ乗り移る。
  applySimulationEvents(simTime: number): void {
    for (const ship of this._entities.players) {
      if (ship.planExecution !== 'instant') continue;
      const node = ship.plan.firstNode();
      if (!node || node.t > simTime + 1e-9) continue;
      // 消化する最後のノードの絶対状態がそのまま到達状態になる(誤差が無い)。
      const nodes = ship.plan.nodes;
      let reached: KinematicState | undefined;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n && n.t <= simTime) { reached = n; break; }
      }
      if (!reached) continue;
      ship.plan.consumeNodesUpTo(simTime, reached);
      ship.state = reached;
    }
  }

  checkWin(): boolean {
    return false;
  }

  // 勝敗のないモードなので、艦を喪失しても敗北画面は出さず通知だけにする。
  recordPlayerLost(reason: string): void {
    this._hud.hint(reason);
  }

  // クリエイティブモードの戦闘ビューでステータスウィンドウ(状況表示・自機装甲/温度/電力ゲージ・放熱板操作)を明示的に表示する。
  hudSubStatus(): string {
    return this.waveAttackEnabled ? '波状攻撃: ON' : 'クリエイティブ';
  }

  // 配置プレビューの軌道線・設定パネル・物体配置パネルを片付けたうえで super.dispose() を呼ぶ。
  dispose(): void {
    super.dispose();
    this.previewEllipseLine.line.removeFromParent();
    this.previewEllipseLine.dispose();
    this.stageControlsPanel.element.remove();
    this.placerPanel.dispose();
  }

  serialize(): CreativeStageSaveData {
    return {
      ...super.serialize(),
      waveAttackEnabled: this.waveAttackEnabled,
      waveAttack: this.waveAttack.serialize(),
    };
  }
}
