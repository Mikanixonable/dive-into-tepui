// クリエイティブモード: 勝敗判定を発生させず、物体配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage, type ObjectAuthoring, type StageDeps } from './stage';
import type { Player } from '../player/player';
import { EntityIdAllocator } from '../game-entity/entity-id';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, semiMajorFromPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { CelestialBody, orbitalElementsOf } from '../../physics/celestial-body';
import { haloState, lissajousState } from '../../physics/halo';
import type { FloatingOrigin } from '../floating-origin';
import { qRotate } from '../../physics/attitude';
import { Vec3, add, addScaled, v3 } from '../../physics/vec3';
import { isOccluded } from '../../physics/occlusion';
import { Button, SegmentedControl, ToggleSwitch, ValueInput } from '../hud/widgets';
import { hudRail } from '../hud/hud-root';
import type { CameraSystem, ProjectFn } from '../camera/camera-system';
import { AmmoPickup } from '../game-entity/ammo-pickup';
import { Base } from '../game-entity/base';
import { generateApproachingEnemy, generateDriftingEnemy, generateProteinEnemy } from './spawner/enemy-generator';
import { PROTEIN_ASSET_IDS, type ProteinAssetId } from '../protein/protein-asset-loader';
import {
  DEFAULT_PROTEIN_DISPLAY, defaultProteinDisplayFor, PROTEIN_COLOR_LABELS, PROTEIN_DISPLAY_LABELS,
  isProteinDisplaySettings, proteinColorModesFor, proteinDisplayWithColor, type Pdb5i4rColorMode, type ProteinDisplaySettings,
  type ProteinRepresentation,
} from '../protein/protein-display';
import { WaveAttack } from './stage-utils/wave-attack';
import { generateRandomName } from '../random-name';
import * as C from '../const';
import { ElementsForm, LagrangeForm, ObjectType, ReferenceCelestialBody, ObjectPlacerForm, ObjectPlacerPanel } from '../creative/object-placer-panel';
import { validateEllipticPlacementFields, validateBaseReferenceFields, validateLagrangePlacementFields, PlacementFieldIssue } from '../creative/placement-validation';
import { elementsFormFromState } from '../creative/duplicate-form';
import { OrbitLine } from '../orbit-line';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import type { MapVisibilityPolicy } from '../celestial/map-visibility';
import type { CreativeStageSaveData, StageSaveData } from '../save-data';

const DEG = Math.PI / 180;

type EnemyShapeDefinition =
  | { readonly id: 'drifting'; readonly family: 'conventional'; readonly kind: 'drifting' }
  | { readonly id: 'stage0-a' | 'stage0-b' | 'stage0-c'; readonly family: 'conventional'; readonly kind: 'stage0'; readonly typeIndex: number }
  | { readonly id: ProteinAssetId; readonly family: 'protein'; readonly kind: 'protein'; readonly assetId: ProteinAssetId };

const STAGE_CONTROL_ENEMY_SHAPES: readonly EnemyShapeDefinition[] = [
  { id: 'drifting', family: 'conventional', kind: 'drifting' },
  { id: 'stage0-a', family: 'conventional', kind: 'stage0', typeIndex: 0 },
  { id: 'stage0-b', family: 'conventional', kind: 'stage0', typeIndex: 1 },
  { id: 'stage0-c', family: 'conventional', kind: 'stage0', typeIndex: 2 },
  ...PROTEIN_ASSET_IDS.map((assetId) => ({ id: assetId, family: 'protein', kind: 'protein', assetId } as const)),
];
type EnemySpawnShape = typeof STAGE_CONTROL_ENEMY_SHAPES[number]['id'];
const STAGE_CONTROL_ENEMY_COLORS = [
  [0xff4a3d, '赤'], [0xff7a2d, '橙'], [0xe0409f, '桃'], [0xbf3dff, '紫'], [0x3dc6ff, '青'],
] as const;
const STAGE_CONTROL_DEFAULT_ENEMY_SPAWN_DISTANCE = 200;

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  static readonly selectLabel = 'CREATIVE';
  static readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  static readonly selectGroup = 'クリエイティブモード';
  static readonly selectKeys: string[] = [];
  readonly freeProcurement = true;
  readonly executesPlans = true;
  readonly authoring: ObjectAuthoring = this;

  private readonly placerPanel: ObjectPlacerPanel;
  // 補給の自動投入・敵の波状攻撃を切り替えるトグルを載せたパネル。マップ視点でだけ出す。
  private readonly stageControlsPanel: HTMLElement;
  private spawnEnemyButtons: Button[] = [];
  private readonly waveAttack: WaveAttack;
  // 敵の波状攻撃を発生させるかどうか。既定 OFF — ON の間だけ update が WaveAttack を進める。
  private waveAttackEnabled: boolean;
  private readonly previewOrbitLine: OrbitLine;
  // 物体配置パネルのフォーム値から求めた配置プレビュー。出すものが無ければ null。
  private preview: { readonly elements: OrbitalElements; readonly pos: Vec3 } | null = null;
  // 現在のフォーム値に対するフィールド単位の検証結果。パネルが閉じている間は空。
  private issues: readonly PlacementFieldIssue[] = [];
  private readonly playerIdAllocator = new EntityIdAllocator('creative-player-');
  private readonly ammoPickupIdAllocator = new EntityIdAllocator('creative-ammo-');
  private activePlayer: Player | null = null;
  private manualEnemyCount = 0;
  private manualEnemySpawnDistance = STAGE_CONTROL_DEFAULT_ENEMY_SPAWN_DISTANCE;
  private proteinDisplay: ProteinDisplaySettings = DEFAULT_PROTEIN_DISPLAY;
  private readonly proteinDisplayByRepresentation = new Map<ProteinRepresentation, ProteinDisplaySettings>([
    ['molecular', defaultProteinDisplayFor('molecular')],
    ['ribbon', DEFAULT_PROTEIN_DISPLAY],
    ['silhouette', defaultProteinDisplayFor('silhouette')],
  ]);

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
    const restoredProtein = this._entities.enemies.find((enemy) => enemy.enemyKind.kind === 'protein' && isProteinDisplaySettings(enemy.enemyKind.display));
    if (restoredProtein && restoredProtein.enemyKind.kind === 'protein' && isProteinDisplaySettings(restoredProtein.enemyKind.display)) {
      this.proteinDisplay = restoredProtein.enemyKind.display;
      this.proteinDisplayByRepresentation.set(this.proteinDisplay.representation, this.proteinDisplay);
    }

    this.previewOrbitLine = new OrbitLine({ color: 0xffffff, opacity: 0.6, renderOrder: LINE_RENDER_ORDER.plan });
    this._scene.add(this.previewOrbitLine.line);

    this.placerPanel = new ObjectPlacerPanel(
      this._hud.mapRoot, this._hud.layers.popup, this._ephemeris, this._hud.overlayManager,
    );
    this.placerPanel.onConfirm = (name, form) => this.placeObject(name, form);
    this.waveAttack = new WaveAttack(this._hud, this._worldSfx, this._fx, this._scene, this._ephemeris, savedCreative?.waveAttack);
    this.waveAttackEnabled = savedCreative?.waveAttackEnabled ?? false;
    this.stageControlsPanel = this.buildStageControlsPanel(this._hud.mapRoot);

    this.begin();
  }

  // 補給の自動投入・敵の波状攻撃のトグルを載せたステージ操作パネルを組み立て、右ドックへ追加して返す。
  private buildStageControlsPanel(hudRoot: HTMLElement): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'hud-stage-controls';
    panel.className = 'panel hidden';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'ステージ操作';
    panel.appendChild(title);
    const body = document.createElement('div');
    body.className = 'stage-controls-body';
    panel.appendChild(body);
    const compactToggle = new ToggleSwitch('コンパクト表示', (on) => {
      body.classList.toggle('hidden', on);
    });
    compactToggle.setOn(false);
    panel.insertBefore(compactToggle.element, body);
    const resupplyToggle = new ToggleSwitch('弾薬の自動投入', (on) => { this.logistics.resupplyEnabled = on; });
    resupplyToggle.setOn(this.logistics.resupplyEnabled);
    body.appendChild(resupplyToggle.element);
    const waveAttackToggle = new ToggleSwitch('敵の波状攻撃', (on) => { this.waveAttackEnabled = on; });
    waveAttackToggle.setOn(this.waveAttackEnabled);
    body.appendChild(waveAttackToggle.element);

    const spawnDistanceWrapper = document.createElement('label');
    spawnDistanceWrapper.className = 'stage-control-select';
    const spawnDistanceTitle = document.createElement('span');
    spawnDistanceTitle.textContent = '敵のスポーン距離 (m)';
    spawnDistanceWrapper.appendChild(spawnDistanceTitle);
    const spawnDistanceInput = new ValueInput({ type: 'number', min: 0, step: 1 }, (text) => {
      const distance = Number(text);
      if (Number.isFinite(distance) && distance >= 0) {
        this.manualEnemySpawnDistance = distance;
      }
      spawnDistanceInput.setValue(String(this.manualEnemySpawnDistance));
    });
    spawnDistanceInput.setValue(String(this.manualEnemySpawnDistance));
    spawnDistanceWrapper.appendChild(spawnDistanceInput.element);
    body.appendChild(spawnDistanceWrapper);

    const conventionalShapes = STAGE_CONTROL_ENEMY_SHAPES.filter(({ family }) => family === 'conventional');
    const proteinShapes = STAGE_CONTROL_ENEMY_SHAPES.filter(({ family }) => family === 'protein');
    let selectedConventionalShape: EnemySpawnShape = conventionalShapes[0]!.id;
    const conventionalSection = document.createElement('div');
    conventionalSection.className = 'stage-control-section';
    const conventionalTitle = document.createElement('div');
    conventionalTitle.className = 'stage-control-section-title';
    conventionalTitle.textContent = '従来型の敵';
    conventionalSection.appendChild(conventionalTitle);
    const shapeControl = new SegmentedControl<EnemySpawnShape>(
      '敵の形状', conventionalShapes.map(({ id }) => [id, id] as const),
      (shape) => {
        selectedConventionalShape = shape;
        shapeControl.setSelected(shape);
      },
    );
    shapeControl.element.classList.add('stage-control-shapes');
    shapeControl.setSelected(selectedConventionalShape);
    conventionalSection.appendChild(shapeControl.element);
    const colorSelect = this.buildStageControlSelect('敵の色', STAGE_CONTROL_ENEMY_COLORS);
    conventionalSection.appendChild(colorSelect.wrapper);
    const conventionalSpawnButton = new Button('敵をスポーン', () => {
      this.spawnManualEnemy(selectedConventionalShape, colorSelect.select.value);
    });
    conventionalSection.appendChild(conventionalSpawnButton.element);
    body.appendChild(conventionalSection);

    let selectedProteinShape: EnemySpawnShape = proteinShapes[0]!.id;
    const proteinSection = document.createElement('div');
    proteinSection.className = 'stage-control-section';
    const proteinTitle = document.createElement('div');
    proteinTitle.className = 'stage-control-section-title';
    proteinTitle.textContent = 'タンパク質型の敵';
    proteinSection.appendChild(proteinTitle);
    const proteinShapeControl = new SegmentedControl<EnemySpawnShape>(
      '敵の形状', proteinShapes.map(({ id }) => [id, id] as const),
      (shape) => {
        selectedProteinShape = shape;
        proteinShapeControl.setSelected(shape);
      },
    );
    proteinShapeControl.element.classList.add('stage-control-shapes');
    proteinShapeControl.setSelected(selectedProteinShape);
    proteinSection.appendChild(proteinShapeControl.element);
    const representationItems = (Object.keys(PROTEIN_DISPLAY_LABELS) as ProteinRepresentation[])
      .map((representation) => [representation, PROTEIN_DISPLAY_LABELS[representation]] as const);
    const proteinDisplayControl = new SegmentedControl<ProteinRepresentation>(
      '表示形態', representationItems,
      (representation) => {
        this.proteinDisplay = this.proteinDisplayByRepresentation.get(representation) ?? defaultProteinDisplayFor(representation);
        this.proteinDisplayByRepresentation.set(representation, this.proteinDisplay);
        proteinDisplayControl.setSelected(representation);
        updateProteinColorItems();
        this.applyProteinDisplay(this.proteinDisplay);
      },
    );
    proteinDisplayControl.element.classList.add('stage-control-protein-representation');
    proteinDisplayControl.setSelected(this.proteinDisplay.representation);
    proteinSection.appendChild(proteinDisplayControl.element);
    const proteinColorControl = new SegmentedControl<Pdb5i4rColorMode>('着色', [], (mode) => {
      const next = proteinDisplayWithColor(this.proteinDisplay.representation, mode);
      if (next === null) return;
      this.proteinDisplay = next;
      this.proteinDisplayByRepresentation.set(next.representation, next);
      proteinColorControl.setSelected(mode);
      this.applyProteinDisplay(next);
    });
    proteinColorControl.element.classList.add('stage-control-protein-colors');
    const updateProteinColorItems = (): void => {
      const modes = proteinColorModesFor(this.proteinDisplay.representation);
      proteinColorControl.setItems(modes.map((mode) => [mode, PROTEIN_COLOR_LABELS[mode]] as const));
      proteinColorControl.setSelected(this.proteinDisplay.colorMode);
    };
    updateProteinColorItems();
    proteinSection.appendChild(proteinColorControl.element);
    const proteinSpawnButton = new Button('敵をスポーン', () => {
      this.spawnManualEnemy(selectedProteinShape, String(0xffffff));
    });
    proteinSection.appendChild(proteinSpawnButton.element);
    body.appendChild(proteinSection);
    this.spawnEnemyButtons = [conventionalSpawnButton, proteinSpawnButton];
    hudRail(hudRoot, 'right').appendChild(panel);
    return panel;
  }

  private buildStageControlSelect<T extends number>(
    label: string, items: readonly (readonly [T, string])[],
  ): { readonly wrapper: HTMLElement; readonly select: HTMLSelectElement } {
    const wrapper = document.createElement('label');
    wrapper.className = 'stage-control-select';
    const title = document.createElement('span');
    title.textContent = label;
    wrapper.appendChild(title);
    const select = document.createElement('select');
    select.className = 'w-select';
    select.setAttribute('aria-label', label);
    select.addEventListener('keydown', (event) => event.stopPropagation());
    for (const [value, text] of items) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = text;
      select.appendChild(option);
    }
    wrapper.appendChild(select);
    return { wrapper, select };
  }

  private applyProteinDisplay(display: ProteinDisplaySettings): void {
    for (const enemy of this._entities.enemies) enemy.setProteinDisplay(display);
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
    const state = kinematicState(player.state.t, position, player.state.v);
    const name = `MANUAL-${++this.manualEnemyCount}`;
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return;
    const enemy = shapeDefinition.kind === 'drifting'
      ? generateDriftingEnemy(name, state, C.ENEMY_MAX_HP, color, color, this._hud, this._worldSfx, this._fx, this._scene)
      : shapeDefinition.kind === 'protein'
        ? generateProteinEnemy(name, state, shapeDefinition.assetId, this.proteinDisplay, this._hud, this._worldSfx, this._fx, this._scene)
      : generateApproachingEnemy(
        name, state, C.STAGE0_ENEMY_HP, color, color, shapeDefinition.typeIndex, undefined,
        this._hud, this._worldSfx, this._fx, this._scene,
      );
    this.addEnemy(enemy, this._entities);
  }

  // ステージ操作パネルは、表示中のワールドビューの右ドックへ追従させる。
  private mountStageControlsPanel(inMapView: boolean): void {
    const root = inMapView ? this._hud.mapRoot : this._hud.combatRoot;
    const rightRail = hudRail(root, 'right');
    if (this.stageControlsPanel.parentElement === rightRail) return;
    const vessel = rightRail.querySelector<HTMLElement>('#hud-vessel-status');
    if (vessel !== null) rightRail.insertBefore(this.stageControlsPanel, vessel);
    else rightRail.appendChild(this.stageControlsPanel);
  }

  // 共通のステータス表示に加えて、配置プレビューの軌道線とマーカーを同期する。
  sync(
    player: Player | null, fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    super.sync(player, fo, cameraSystem, displayTime, visibilityPolicy);
    this.activePlayer = player;
    for (const button of this.spawnEnemyButtons) button.setEnabled(player !== null && player.alive);
    this.mountStageControlsPanel(cameraSystem.overviewMode);
    this.syncPreview(
      fo, cameraSystem.activeCameraProjection, cameraSystem.activeCamera,
      cameraSystem.overviewMode, cameraSystem.activeCameraPos, this._ephemeris.celestialBodiesAt(displayTime),
    );
    this.placerPanel.setIssues(this.issues);
    this.stageControlsPanel.classList.remove('hidden');
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
  openObjectPlacerForDuplicate(objectType: ObjectType, state: KinematicState): void {
    const celestialBodies = this._ephemeris.celestialBodiesAt(this._simulator.simTime);
    const form = elementsFormFromState(state, celestialBodies, this._ephemeris.originId);
    if (form && validateBaseReferenceFields(objectType, 'elements', form.celestialBody).length === 0) {
      this.placerPanel.open({ kind: 'form', objectType, form });
      return;
    }
    this._hud.hint('この軌道は要素として複製できないため、種類だけを引き継いだ新規配置として開きます');
    this.placerPanel.open({ kind: 'objectType', objectType });
  }

  // フォーム値から配置プレビューの軌道要素と位置を求める。軌道要素指定以外の配置方法・
  // 入力を解釈できない値のときは null(プレビューを出さない)。
  private computePreview(form: ObjectPlacerForm): { elements: OrbitalElements; pos: Vec3 } | null {
    if (form.placementMode !== 'elements') return null;
    try {
      const state = this.buildInitialState(form);
      // 楕円はフォームが選んだ基準天体中心で描く。
      const elements = orbitalElementsOf(state, this.referenceCelestialBody(form));
      return elements ? { elements, pos: state.r } : null;
    } catch {
      return null;
    }
  }

  // フォーム値をフィールド単位で検証する。assertValidForm(確定時、最初の問題で例外を投げる)と
  // 同じ検証呼び出しを共有し、両者が食い違うことを防ぐ。
  private computeFieldIssues(form: ObjectPlacerForm): PlacementFieldIssue[] {
    const issues = [...validateBaseReferenceFields(
      form.objectType, form.placementMode, form.placementMode === 'elements' ? form.celestialBody : undefined,
    )];
    if (form.placementMode === 'elements') {
      const center = this.referenceCelestialBody(form);
      const common = {
        centerRadius: center.radius, mu: center.mu, centerId: center.id,
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
    overviewMode: boolean, cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
  ): void {
    if (!this.preview) {
      this.previewOrbitLine.sync(null, fo, camera);
      this._markerManager.fadeOut('creative-preview');
      return;
    }
    this.previewOrbitLine.sync(this.preview.elements, fo, camera);
    if (overviewMode && isOccluded(cameraPos, this.preview.pos, celestialBodies)) {
      this._markerManager.hide('creative-preview');
      return;
    }
    this._markerManager.setPosition(
      'creative-preview', 'mk-self', ENTITY_GLYPH.preview, this.preview.pos, project,
      'PREVIEW', 1, C.COLOR_MARKER_ALLY, 0, false, false, undefined, cameraPos,
    );
  }

  // フォーム値から KinematicState を組み立て、配置する。
  private placeObject(name: string, form: ObjectPlacerForm): void {
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
        const finalName = name.trim() || generateRandomName('player');
        const ship = this.addPlayer({ name: finalName, state, id });
        this._hud.hint(`${ship.name} を配置`);
      } else if (form.objectType === 'enemy') {
        const finalName = name.trim() || generateRandomName('enemy');
        const enemy = generateDriftingEnemy(finalName, state, C.ENEMY_MAX_HP, '#ff6a00', '#ff6a00', this._hud, this._worldSfx, this._fx, this._scene);
        this._entities.addEnemy(enemy);
        this._hud.hint(`${enemy.name} を配置`);
      } else if (form.objectType === 'ammo') {
        const id = this.ammoPickupIdAllocator.next();
        const ammoPickup = new AmmoPickup({ state, id }, this._scene);
        this._entities.addAmmoPickup(ammoPickup);
        const finalName = name.trim() || generateRandomName('ammo');
        this._hud.hint(`${finalName} を配置`);
      } else if (form.objectType === 'base') {
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
  private referenceCelestialBody(form: ElementsForm): CelestialBody {
    return this._ephemeris.celestialBodiesAt(this._simulator.simTime).find((b) => b.id === form.celestialBody)!;
  }

  // フォームが選んだサイズ/形の組から長半径・離心率を導出し、要素→状態変換
  // (stateFromOrbitalElements)で基準天体中心の相対状態を組んでから、基準天体自身の位置・速度を
  // 足して ECI 化する(地球基準では位置・速度とも厳密に 0 なので、実質そのまま返る)。
  private buildElementsState(form: ElementsForm): KinematicState {
    const center = this.referenceCelestialBody(form);
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
    this.previewOrbitLine.line.removeFromParent();
    this.previewOrbitLine.dispose();
    this.stageControlsPanel.remove();
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
