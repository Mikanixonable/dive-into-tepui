// クリエイティブモード: 勝敗判定を発生させず、物体配置と軌道計画を自由に試すためのステージ。
import { Stage, type ObjectAuthoring, type StageDeps, STORY_EPOCH } from './stage';
import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, semiMajorFromPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { orbitalElementsOf } from '../../physics/elements';
import { haloState, lissajousState } from '../../physics/halo';
import { secondaryFrameOf } from '../../physics/lagrange';
import { OrbitingMotion } from '../../physics/celestial-motion';
import type { FloatingOrigin } from '../camera/floating-origin';
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { Vec3, add, addScaled } from '../../math/vec3';
import { isOccluded } from '../../physics/occlusion';
import { hudRail } from '../hud/hud-root';
import type { CameraSystem } from '../camera/camera-system';
import { AmmoPickup, isAmmoPickup } from '../dynamic/dynamic-entity/ammo-pickup';
import { isRcsFuelPickup, RcsFuelPickup } from '../dynamic/dynamic-entity/rcs-fuel-pickup';
import { Base } from '../dynamic/dynamic-entity/base';
import { generateApproachingEnemy, generateDriftingEnemy, generateProteinEnemy, proteinFormationSpawns } from './spawner/enemy-generator';
import { DEFAULT_PROTEIN_DISPLAY, type ProteinDisplaySettings } from '../protein/protein-display';
import { proteinAssetGate } from '../protein/protein-asset-loader';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { isPlayer } from '../player/player';
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
import type { CelestialBody } from '../../physics/celestial-body';

// 軌道上へ配置できる自機の上限隻数。
const MAX_PLACED_SHIPS = 50;

const DEG = Math.PI / 180;

// 手動スポーンで敵を出す、自機前方の既定距離 [m]。
const STAGE_CONTROL_DEFAULT_ENEMY_SPAWN_DISTANCE = 2000;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  static readonly epoch = STORY_EPOCH;
  // 開始日時の指定画面を挟む(SPEC GAME.md 9.0)。epoch はその欄の既定値になる。
  static readonly picksStartEpoch = true;
  static readonly selectLabel = 'CREATIVE';
  static readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  static readonly selectGroup = 'クリエイティブモード';
  static readonly selectKeys: string[] = [];
  readonly executesPlans = true;
  readonly authoring: ObjectAuthoring = this;

  private readonly placerPanel: ObjectPlacerPanel;
  // 補給の自動投入・敵の波状攻撃を切り替えるトグルを載せたパネル。
  private readonly stageControlsPanel: StageControlsPanel;
  private readonly waveAttack: WaveAttack;
  // 敵の波状攻撃を発生させるかどうか(既定 OFF)。
  private waveAttackEnabled: boolean;
  private readonly previewEllipseLine: EllipseLine;
  private readonly playerIdAllocator = new EntityIdAllocator('creative-player-');
  private readonly ammoPickupIdAllocator = new EntityIdAllocator('creative-ammo-');
  private readonly rcsFuelPickupIdAllocator = new EntityIdAllocator('creative-rcs-fuel-');
  private manualEnemyCount = 0;
  private manualFormationCount = 0;
  private manualEnemySpawnDistance = STAGE_CONTROL_DEFAULT_ENEMY_SPAWN_DISTANCE;
  // 手動スポーンで使うタンパク質の表示設定。
  private proteinDisplay: ProteinDisplaySettings = DEFAULT_PROTEIN_DISPLAY;

  // ステージ開始時に出すブリーフィングの本文(HTML)。
  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // 配置パネルとステージ操作パネルを組み、保存データがあればそこから状態を戻す。
  // saved の型が StageSaveData なのは、復元の構築シグネチャを全ステージで揃えるため。
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    const savedCreative = saved as CreativeStageSaveData | undefined;

    // 以後の新規配置が既存 id と衝突しないよう、復元済みの艦・補給の id を予約する。
    const entities = this._dynamicSystem.all();
    for (const p of entities.filter(isPlayer)) this.playerIdAllocator.next(p.id);
    for (const ammoPickup of entities.filter(isAmmoPickup)) this.ammoPickupIdAllocator.next(ammoPickup.id);
    for (const pickup of entities.filter(isRcsFuelPickup)) this.rcsFuelPickupIdAllocator.next(pickup.id);
    const restoredProtein = entities.find((entity) => entity instanceof ProteinEnemy);
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
    this.stageControlsPanel.onRefillAmmo = () => this.refillShipAmmo();
    this.stageControlsPanel.onRefillFuel = () => this.refillShipRcsFuel();
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

  // 出ているタンパク質の敵すべてへ、選ばれた表示設定を反映する。
  private applyProteinDisplay(display: ProteinDisplaySettings): void {
    for (const entity of this._dynamicSystem.all()) {
      if (entity instanceof ProteinEnemy) entity.setDisplay(display);
    }
  }

  // 操作艦の弾薬を満載にする。操作艦がいなければトーストで知らせる。
  private refillShipAmmo(): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため弾薬を補充できません');
      return;
    }
    player.refillAmmo();
  }

  // 操作艦の RCS 燃料を満タンにする。操作艦がいなければトーストで知らせる。
  private refillShipRcsFuel(): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないためRCS燃料を補充できません');
      return;
    }
    player.refuelFuel(player.totalMaxFuel);
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す。操作艦がいなければトーストで知らせる。
  private spawnManualEnemy(shape: EnemySpawnShape, colorValue: string): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため敵をスポーンできません');
      return;
    }
    // 自機の前方、同じ速度で置く。
    const color = Number(colorValue);
    const forward = qRotate(player.att.q, LOCAL_FORWARD);
    const position = addScaled(player.state.r, forward, this.manualEnemySpawnDistance);
    const state = kinematicState<'eci'>(player.state.t, position, player.state.v);
    const name = `MANUAL-${++this.manualEnemyCount}`;
    // 形ごとに生成器が違い、タンパク質はアセットが揃うのを待ってから出す。
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return;
    if (shapeDefinition.kind === 'drifting') {
      this.addEnemy(generateDriftingEnemy(name, state, color, color, this._worldSfx, this._fx, this._scene));
      return;
    }
    if (shapeDefinition.kind === 'protein') {
      this.spawnEnemyWhenReady(
        proteinAssetGate(shapeDefinition.assetId),
        () => generateProteinEnemy(name, state, shapeDefinition.assetId, this.proteinDisplay, this._worldSfx, this._fx, this._scene),
      );
      return;
    }
    this.addEnemy(generateApproachingEnemy(
      name, state, color, color, shapeDefinition.typeIndex, undefined,
      this._worldSfx, this._fx, this._scene,
    ));
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機前方に一括スポーンする。
  private spawnProteinFormation(): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため敵をスポーンできません');
      return;
    }
    // 3役はいずれも自機の前方、同じ速度から始める。
    const forward = qRotate(player.att.q, LOCAL_FORWARD);
    const position = addScaled(player.state.r, forward, this.manualEnemySpawnDistance);
    const state = kinematicState<'eci'>(player.state.t, position, player.state.v);
    const name = `FORMATION-${++this.manualFormationCount}`;
    const formationId = name;
    for (const { assetId, build } of proteinFormationSpawns(name, state, player.state.r, this.proteinDisplay, formationId, this._worldSfx, this._fx, this._scene)) {
      this.spawnEnemyWhenReady(proteinAssetGate(assetId), build);
    }
  }

  // ステージ操作パネルは、表示中のビューの右ドックへ追従させる。
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
    fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    super.sync(fo, cameraSystem, displayTime, visibilityPolicy);
    const ship = this.ship;
    this.stageControlsPanel.setSpawnButtonsEnabled(ship !== null && ship.alive);
    this.mountStageControlsPanel(cameraSystem.view === 'map');
    const form = this.placerPanel.isOpen ? this.placerPanel.getForm() : null;
    this.syncPreview(form, fo, cameraSystem, displayTime);
    this.placerPanel.setIssues(form ? this.computeFieldIssues(form) : []);
    this.stageControlsPanel.element.classList.remove('hidden');
  }

  // オブジェクト配置モーダルを開く。focusId はマップの現在フォーカスで、
  // 基準天体になれる ID なら基準天体の初期選択に使う。
  openObjectPlacer(focusId?: string): void {
    this.placerPanel.open(focusId !== undefined ? { kind: 'body', celestialBody: focusId as ReferenceCelestialBody } : undefined);
  }

  // 右クリックメニューの「複製」。state を軌道要素へ逆算でき、基地の基準天体制約も満たす値が
  // 求まったときは、その値をプリセットして開く。逆算できない軌道(双曲線など)や制約に反する
  // 複製元では、値を引き継ぐと制約外の軌道が黙って配置できてしまうので、種類だけを引き継ぐ。
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

  // フォーム値をフィールド単位で検証する。assertValidForm と同じ検証を通し、
  // 入力中の表示と確定時の可否が食い違わないようにする。
  private computeFieldIssues(form: ObjectPlacerForm): PlacementFieldIssue[] {
    // 配置方法によらず効く、種類ごとの基準天体の制約。
    const issues = [...validateBaseReferenceFields(
      form.entityKind, form.placementMode, form.placementMode === 'elements' ? form.celestialBody : undefined,
    )];
    // 配置方法ごとの制約。
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

  // フォーム値から求めた配置プレビューの軌道線と ▷ マーカーを同期する。
  // form が null か、プレビューを出せない値のときは、軌道線とマーカーを消す。
  private syncPreview(
    form: ObjectPlacerForm | null, fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number,
  ): void {
    const preview = form ? this.computePreview(form) : null;
    if (!preview) {
      this.previewEllipseLine.hide();
      this._markerManager.fadeOut('creative-preview');
      return;
    }
    // 軌道線は常に出し、▷ マーカーは天体に隠れていないときだけ出す。
    const cameraPos = cameraSystem.activeCameraPos;
    this.previewEllipseLine.sync(preview.elements, fo, cameraSystem.activeCamera);
    if (cameraSystem.view === 'map'
      && isOccluded(cameraPos, preview.pos, this._celestialSystem.celestialMotions, displayTime)) {
      this._markerManager.hide('creative-preview');
      return;
    }
    this._markerManager.setPosition(
      'creative-preview', 'mk-self', ENTITY_GLYPH.preview, preview.pos, cameraSystem.activeCameraProjection,
      'PREVIEW', 1, COLOR_MARKER_ALLY, 0, false, false, undefined, cameraPos,
    );
  }

  // フォーム値から KinematicState を組み立て、配置する。
  private placeObject(name: string, form: ObjectPlacerForm): void {
    if (form.entityKind === 'player' && this._dynamicSystem.all().filter(isPlayer).length >= MAX_PLACED_SHIPS) {
      this._hud.hint(`配置数が上限(${MAX_PLACED_SHIPS}隻)に達しています`);
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      
      // 種類ごとに実体を作って登録し、配置したことを知らせる。
      if (form.entityKind === 'player') {
        const id = this.playerIdAllocator.next();
        const finalName = name.trim() || generateRandomName('player');
        const ship = this.addPlayer({ name: finalName, state, id });
        this._hud.hint(`${ship.name} を配置`);
      } else if (form.entityKind === 'enemy') {
        const finalName = name.trim() || generateRandomName('enemy');
        const enemy = generateDriftingEnemy(finalName, state, '#ff6a00', '#ff6a00', this._worldSfx, this._fx, this._scene);
        this._dynamicSystem.add(enemy);
        this._hud.hint(`${enemy.name} を配置`);
      } else if (form.entityKind === 'ammo') {
        const id = this.ammoPickupIdAllocator.next();
        const ammoPickup = new AmmoPickup({ state, id }, this._scene);
        this._dynamicSystem.add(ammoPickup);
        const finalName = name.trim() || generateRandomName('ammo');
        this._hud.hint(`${finalName} を配置`);
      } else if (form.entityKind === 'fuel') {
        const id = this.rcsFuelPickupIdAllocator.next();
        const finalName = name.trim() || generateRandomName('fuel');
        this._dynamicSystem.add(new RcsFuelPickup({ state, id, name: finalName }, this._scene));
        this._hud.hint(`${finalName} を配置`);
      } else if (form.entityKind === 'base') {
        const finalName = name.trim() || generateRandomName('base');
        const base = new Base({ state, name: finalName }, this._scene, this._hud, this._worldSfx, this._markerManager);
        this._dynamicSystem.add(base);
        this._hud.hint(`${base.name} を配置`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '入力を解釈できません';
      this._hud.hint(`配置できません: ${message}`, 5000);
    }
  }

  // フォームの placementMode に応じて、軌道要素指定かラグランジュ点指定で初期状態を組む。
  private buildInitialState(form: ObjectPlacerForm): KinematicState {
    if (form.placementMode === 'lagrange') return this.buildLagrangeState(form);
    return this.buildElementsState(form);
  }

  // ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。ハローの面内振幅は
  // 三次の振幅拘束で面外振幅から決まるので、フォームに面内振幅の欄がない。
  private buildLagrangeState(form: LagrangeForm): KinematicState {
    const motion = this._celestialSystem.entityOf(form.lagrangeSecondary).motion;
    if (!(motion instanceof OrbitingMotion)) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} は公転していないのでラグランジュ点を持たない`);
    }
    const t = this._dynamicSystem.simTime;
    const system = secondaryFrameOf(this._celestialSystem.celestialMotions, t, motion, t);
    if (system === null) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} の主天体が引けない`);
    }
    if (form.lagrangeOrbitKind === 'halo') {
      return haloState(system, { point: form.lagrangePoint, az: form.azKm * 1e3 });
    }
    return lissajousState(system, { point: form.lagrangePoint, ax: form.axKm * 1e3, az: form.azKm * 1e3 });
  }

  // フォームが選んだ基準天体の運動を引く。
  private referenceCelestialBody(form: ElementsForm): CelestialBody {
    return this._celestialSystem.motionOf(form.celestialBody);
  }

  // フォームのサイズ/形の指定から軌道要素を組み、基準天体中心の状態を ECI へ直して返す。
  private buildElementsState(form: ElementsForm): KinematicState {
    const center = this.referenceCelestialBody(form);
    const centerState = center.stateAt(this._dynamicSystem.simTime);
    // サイズの指定方法ごとに長半径と離心率を出す。
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

    // 基準天体中心の相対状態を組み、基準天体自身の位置・速度を足して ECI にする。
    const rel = stateFromOrbitalElements(
      this._dynamicSystem.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG,
      form.nuDeg * DEG, center.def.mu,
    );
    return kinematicState<'eci'>(
      this._dynamicSystem.simTime, add(centerState.r, rel.r), add(centerState.v, rel.v));
  }

  // フォームの値が物理的に成立するか検証し、不正なら最初の問題を理由に例外を投げる。
  private assertValidForm(form: ObjectPlacerForm): void {
    const [firstIssue] = this.computeFieldIssues(form);
    if (firstIssue) throw new Error(firstIssue.message);
  }

  // 位置・速度に非有限値が混じっていたら例外を投げる。
  private assertFiniteEllipticState(state: KinematicState): void {
    const values = [state.r.x, state.r.y, state.r.z, state.v.x, state.v.y, state.v.z];
    if (!values.every(Number.isFinite)) throw new Error('有限の状態を作れませんでした');
  }

  // 補給の投入と波状攻撃を進める。波状攻撃のトグルが決めるのは新しいウェーブが出るかどうかで、
  // OFF にしても既に出ている敵は残る。
  update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (player) {
      this.logistics.updateLogistics(simTime, player, simSpeed, true);
      if (this.waveAttackEnabled) {
        this.waveAttack.update(
          dt, player, this._dynamicSystem.all().filter(isEnemy), simTime, this,
          (enemy) => this.addEnemy(enemy));
      }
    }
  }

  // 'instant' の艦が次に消化するノードの時刻。積分をその時刻ちょうどで切らせるために返す。
  // 待っているノードが1つも無ければ null。
  nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._dynamicSystem.all().filter(isPlayer)) {
      const t = ship.planExecution === 'instant' ? ship.plan.firstNode()?.t : undefined;
      if (t !== undefined && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  // ノード時刻ちょうどでノードの絶対状態へ乗り移る。
  applySimulationEvents(simTime: number): void {
    for (const ship of this._dynamicSystem.all().filter(isPlayer)) {
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

  // 勝利条件を持たないモードなので、常に false。
  checkWin(): boolean {
    return false;
  }

  // 艦を喪失したことを、トーストで知らせる。
  recordPlayerLost(reason: string): void {
    this._hud.hint(reason);
  }

  // ステータス表示の副題に出す文字列。
  hudSubStatus(): string {
    return this.waveAttackEnabled ? '波状攻撃: ON' : 'クリエイティブ';
  }

  // このステージが持つ表示物とパネルを片付ける。
  dispose(): void {
    super.dispose();
    this.previewEllipseLine.line.removeFromParent();
    this.previewEllipseLine.dispose();
    this.stageControlsPanel.element.remove();
    this.placerPanel.dispose();
  }

  // 共通のステージ保存データへ、波状攻撃のトグルと進行状況を足して返す。
  serialize(): CreativeStageSaveData {
    return {
      ...super.serialize(),
      waveAttackEnabled: this.waveAttackEnabled,
      waveAttack: this.waveAttack.serialize(),
    };
  }
}
