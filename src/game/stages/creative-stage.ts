// クリエイティブモード: 勝敗判定を発生させず、艦艇配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage } from './stage';
import { Player } from '../player/player';
import { EntityIdAllocator } from '../game-entity/entity-id';
import type { StageSaveData } from '../save-data';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { Simulator } from '../simulation/simulator';
import type { MarkerManager } from '../marker/marker-manager';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../marker/marker-glyphs';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, semiMajorFromPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { Attractor, orbitalElementsOf } from '../../physics/attractor';
import { Ephemeris } from '../../physics/ephemeris';
import { haloState, lissajousState } from '../../physics/halo';
import type { FloatingOrigin } from '../floating-origin';
import { Vec3, add } from '../../physics/vec3';
import { HudToggle } from '../hud/buttons';
import { hudDock } from '../hud/dom';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { UnlockManager } from '../unlock-manager';
import { Ammo } from '../game-entity/ammo';
import { Base } from '../game-entity/base';
import { generateDriftingEnemy } from './spawner/enemy-generator';
import * as C from '../const';
import { ElementsForm, LagrangeForm, ObjectType, ReferenceAttractor, ShipPlacerForm, ShipPlacerPanel } from '../creative/ship-placer-panel';
import { validateEllipticPlacementFields, validateBaseReferenceFields, validateLagrangePlacementFields, PlacementFieldIssue } from '../creative/placement-validation';
import { elementsFormFromState } from '../creative/duplicate-form';
import { OrbitLine } from '../../render/orbit-line';
import type { MapVisibilityPolicy } from '../celestial/map-visibility';

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
  // 補給の自動投入を切り替えるトグルのパネル。マップ視点でだけ出す。
  private logisticsPanel!: HTMLElement;
  private previewOrbitLine!: OrbitLine;
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

    this.previewOrbitLine = new OrbitLine(0xffffff, 0.6, C.LINE_RENDER_ORDER.plan);
    scene.add(this.previewOrbitLine.line);

    this.placerPanel = new ShipPlacerPanel(hud.layers.panel, hud.layers.popup, ephemeris);
    this.placerPanel.onConfirm = (name, form) => this.placeObject(name, form);
    this.logisticsPanel = this.buildLogisticsPanel(hud.layers.panel);
  }

  // 補給の自動投入トグルを1つ載せたパネルを組み立て、マップ左ドックへ追加して返す。
  private buildLogisticsPanel(hudRoot: HTMLElement): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'hud-creative-logistics';
    panel.className = 'panel';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'LOGISTICS';
    panel.appendChild(title);
    const toggle = new HudToggle('補給の自動投入', (on) => { this.logistics.resupplyEnabled = on; });
    toggle.setOn(this.logistics.resupplyEnabled);
    panel.appendChild(toggle.element);
    hudDock(hudRoot, 'right').appendChild(panel);
    return panel;
  }

  init(): number {
    return 0;
  }

  // 共通のステータス表示に加えて、配置プレビューの軌道線とマーカー、基地マーカーを同期する。
  sync(player: Player | null, fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, displayTime: number, overviewMode: boolean, visibility: MapVisibilityPolicy | null = null): void {
    super.sync(player, fo, project, scale, displayTime, overviewMode, visibility);
    this.syncPreview(fo, project);
    this.syncBaseMarkers(project, scale, displayTime, overviewMode, visibility);
    this.placerPanel.setIssues(this.issues);
    this.logisticsPanel.style.display = overviewMode ? 'block' : 'none';
  }

  // 基地は実寸(半径100m)のメッシュしか持たず、マップ視点では見えないほど小さいので、
  // 艦と同じ ▲ のポイントマーカーを立てて発見できるようにする。戦闘ビューでは
  // 画面外なら ▣ AMMO の補給と同じ方式の ↑ 方位矢印で補う。overviewMode 中は進行方向を向く
  // 三角形に差し替える(mk-poi は FocusMarkers の天体ラベルと共用するため、専用の mk-base を使う)。
  private syncBaseMarkers(project: ProjectFn, scale: ScaleFn, displayTime: number, overviewMode: boolean, visibility: MapVisibilityPolicy | null): void {
    const bases = this._entities.bases;
    for (const [i, base] of bases.entries()) {
      const key = `base${i}`;
      const bearingKey = `${key}-bearing`;
      const ds = base.alive ? base.displayState(displayTime) : undefined;
      if (!ds) {
        this._markerManager.hide(key);
        this._markerManager.hide(bearingKey);
        continue;
      }
      const display = overviewMode ? visibility?.entity('base') : null;
      if (display && !display.pickable) {
        this._markerManager.hide(key);
        this._markerManager.hide(bearingKey);
        continue;
      }
      const label = '基地';
      const p = project(ds.r);
      if (overviewMode) {
        const rotationDeg = this._markerManager.headingRotationDeg(ds.r, ds.v, project, scale);
        this._markerManager.set(key, 'mk-base', display?.icon === false ? '' : ENTITY_GLYPH.ship, p.x, p.y, p.front, display?.label === false ? '' : label, 1, undefined, rotationDeg);
        this._markerManager.hide(bearingKey);
      } else {
        this._markerManager.set(key, 'mk-poi', display?.icon === false ? '' : ENTITY_GLYPH.body, p.x, p.y, p.front, display?.label === false ? '' : label);
        this._markerManager.setBearing(bearingKey, 'mk-poi', DIRECTION_GLYPH.bearing, p, display?.label === false ? '' : label, 0.9);
      }
    }
    for (let i = bases.length; i < this.lastBaseMarkerCount; i++) {
      this._markerManager.hide(`base${i}`);
      this._markerManager.hide(`base${i}-bearing`);
    }
    this.lastBaseMarkerCount = bases.length;
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
  private syncPreview(fo: FloatingOrigin, project: ProjectFn): void {
    if (!this.preview) {
      this.previewOrbitLine.sync(null, fo);
      this._markerManager.hide('creative-preview');
      return;
    }
    this.previewOrbitLine.sync(this.preview.elements, fo, true);
    this._markerManager.setPosition(
      'creative-preview', 'mk-self', ENTITY_GLYPH.preview, this.preview.pos, project,
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
        const id = this.playerIdAllocator.next();
        const finalName = name || `Player-${this.nextFallbackNameSeq++}`;
        const ship = new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, finalName, state, id);
        this._entities.addPlayer(ship);
        this.onShipPlaced?.(ship);
        this._hud.hint(`${ship.displayName} を配置`);
      } else if (form.objectType === 'enemy') {
        const finalName = name || `Enemy-${this.nextFallbackNameSeq++}`;
        const enemy = generateDriftingEnemy(finalName, state, C.ENEMY_MAX_HP, '#ff6a00', '#ff6a00', this._hud, this._sfx, this._fx, this._scene);
        this._entities.addEnemy(enemy);
        this._hud.hint(`${enemy.name} を配置`);
      } else if (form.objectType === 'ammo') {
        const id = this.ammoIdAllocator.next();
        const ammo = new Ammo(state, undefined, this._scene, id);
        this._entities.addAmmo(ammo);
        const finalName = name || `Ammo-${this.nextFallbackNameSeq++}`;
        this._hud.hint(`${finalName} を配置`);
      } else if (form.objectType === 'base') {
        const finalName = name || `Base-${this.nextFallbackNameSeq++}`;
        const base = new Base(state, this._scene, finalName);
        this._entities.addBase(base);
        this._hud.hint(`${base.name} を配置`);
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
  // ノードの消化・点火・遮断は Simulator のイベント境界(applySimulationEvents)で行う。
  update(dt: number, player: Player | null, _entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (player) this.logistics.updateLogistics(simTime, player, simSpeed, true);
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
        const reached = ship.plan.nodes.filter((n) => n.t <= simTime).at(-1);
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

  // 復元済みエンティティの id を各アロケータへ予約し、以後の新規配置が採番済み id と
  // 衝突しないようにする(Game.restore は super.restore の前に entities を復元済み)。
  restore(data: StageSaveData): void {
    super.restore(data);
    for (const p of this._entities.players) this.playerIdAllocator.next(p.id);
    for (const a of this._entities.ammos) this.ammoIdAllocator.next(a.id);
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
