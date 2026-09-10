// 天体系(天体ビュー・星・天球グリッド・参照軌道線・照明)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { CelestialMotion, OrbitingMotion, PlanetMotion } from '../../physics/celestial-motion';
import { PhaseOffsets } from '../../physics/celestial-body-def';
import { strongestAttractor } from '../../physics/attractor';
import { EphemerisPoints, ephemerisPointOf } from '../../physics/ephemeris/point';
import { EciTransform } from '../../physics/eci-transform';
import { ReferenceFrames } from './reference-frames';
import { isLagrangeId, lagrangeParentId } from './lagrange-id';
import { addTimeCacheStats } from '../../physics/time-ring';
import { KinematicState } from '../../physics/kinematic-state';
import { norm, sub, v3, Vec3 } from '../../math/vec3';
import { CELESTIAL_SHELL_SCALE, createStars, Stars } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility, DEFAULT_GRID_VISIBILITY } from '../../render/celestial-grid';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import { ScaleGridView } from './scale-grid-view';
import { CelestialIllumination, type IlluminationTargets } from './celestial-illumination';
import { RingMaterials } from '../../render/celestial/ring';
import { CelestialEntity } from './celestial-entity/celestial-entity';
import type { StellarLightSource } from '../../render/celestial/celestial-entity/celestial-view';
import { OrbitGuideLines } from './orbit-guide/orbit-guide-lines';
import { ZeroVelocityLines } from './orbit-guide/zero-velocity-lines';
import { DEFAULT_ORBIT_GUIDE_SETTINGS, OrbitGuideSettings } from './orbit-guide/orbit-guide-settings';
import type { TdbJulianDate } from '../../physics/time';
import type { MarkerSlots } from '../marker/marker-slots';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';
import type { PointFieldView } from '../../render/celestial/point-field-view';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CelestialBodies } from './celestial-bodies';
import type { CelestialClass } from './celestial-entity/celestial-entity-def';

// 数値暦が収録している点を、結び先のノードへ配る。暦は id ごとに天体本体を収録している場合と
// 惑星系の重心を収録している場合があり、宣言と食い違う点へ結ぶとその系がまるごと重心オフセット
// ぶんずれる。
function bindEphemerides(motions: readonly CelestialMotion[], points: EphemerisPoints): void {
  for (const motion of motions) {
    motion.bindEphemeris(ephemerisPointOf(points, motion.id, 'body'));
  }
  // 系の重心を収録した系列は惑星系のほうへ結ぶ。
  const systems = new Set(motions
    .filter((m): m is PlanetMotion => m instanceof PlanetMotion)
    .map((m) => m.system));
  for (const system of systems) {
    system.bindEphemeris(ephemerisPointOf(points, system.id, 'systemBarycenter'));
  }
}

// 親を先に、その子を続けて並べた列と、主星を 0 とする階層の深さ。親子関係が循環していても
// 停止し、主星を持たない孤立した天体は深さ 0 で拾う。
function orderedEntitiesOf(
  entities: readonly CelestialEntity[],
): readonly { readonly entity: CelestialEntity; readonly depth: number }[] {
  const ordered: { entity: CelestialEntity; depth: number }[] = [];
  const added = new Set<string>();
  // entity とその子孫を深さ優先で並べる。追加済みなら何もしない。
  const append = (entity: CelestialEntity, depth: number): void => {
    if (added.has(entity.id)) return;
    added.add(entity.id);
    ordered.push({ entity, depth });
    for (const child of entities) {
      if (child.motion.primary?.id === entity.id) append(child, depth + 1);
    }
  };
  // 根(主天体を持たない天体)から辿り、残った孤立・循環の天体も深さ 0 で拾う。
  for (const entity of entities) if (entity.motion.primary === null) append(entity, 0);
  for (const entity of entities) append(entity, 0);
  return ordered;
}

export class CelestialSystem implements CelestialBodies {
  private scene!: THREE.Scene;
  private stars!: Stars;
  private celestialGrid!: CelestialGrid;
  private scaleGrid!: ScaleGridView;
  // 全天体の環の帯が共有するマテリアル。
  private ringMaterials!: RingMaterials;
  // 天体を光源・影・大気として選び、描画パスへ渡す役。
  private illumination!: CelestialIllumination;
  private readonly entitiesById: ReadonlyMap<string, CelestialEntity>;
  // 全登録天体の運動(entities と同じ宣言順)。
  readonly celestialMotions: readonly CelestialMotion[];
  // 親を先に、その子を続けて並べた天体の列と、主星を 0 とする階層の深さ。
  readonly orderedEntities: readonly { readonly entity: CelestialEntity; readonly depth: number }[];
  // 主星の個体。恒星を持たない星系では null。
  private readonly starEntity: CelestialEntity | null;
  private readonly stellarLightSource: StellarLightSource | null;
  // 天体の値を ECI へ移す変換器。どの天体を原点に置くかは系レベルの選択なので、正本はここが持つ。
  private readonly eciTransform: EciTransform;
  // 座標系の同一性。entities の motion から組む。
  private readonly referenceFrames: ReferenceFrames;

  // mu が 0 でない天体と、大気を持つ天体(いずれも宣言順)。どちらも時刻に依らないので
  // 構築時に確定する。
  private readonly gravityMotionList: readonly CelestialMotion[];
  private readonly atmosphereMotionList: readonly CelestialMotion[];

  // 点群をシーンへ登録済みか。登録は最初にマップを描くとき。
  private pointFieldBuilt = false;

  // ラグランジュ点まわりの周期・準周期軌道のガイド線(表示パネルの軌道ガイドタブ、静止軌道を除く)。
  private orbitGuideLines!: OrbitGuideLines;
  // ゼロ速度曲線(ガイドタブ5.3節)。
  private zeroVelocityLines!: ZeroVelocityLines;
  // 軌道ガイドタブの設定の写し。静止軌道リング・ラベルの表示可否を持つ。
  private orbitGuideSettings: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;
  // 表示パネルの天球グリッド設定の写し。星・面・極・目安グリッドの表示可否を持つ。
  private gridVisibility: CelestialGridVisibility = DEFAULT_GRID_VISIBILITY;

  // entities はこの星系の全天体(宣言順)、origin はその中の ECI 中心天体。phaseOffsets は motion を
  // 組むのに使った初期位相で、セーブでそのまま返すために保持する。epoch は simTime=0 が指す絶対時刻。
  // pointFieldView は付随する小天体の点群(持たない星系では null)、ephemerisPoints は数値暦が
  // 収録している点の一覧。
  constructor(
    public readonly entities: readonly CelestialEntity[],
    public readonly origin: CelestialEntity,
    private readonly phaseOffsets: PhaseOffsets,
    public readonly epoch: TdbJulianDate,
    private readonly pointFieldView: PointFieldView | null = null,
    ephemerisPoints: EphemerisPoints | null = null,
  ) {
    this.celestialMotions = entities.map((b) => b.motion);
    this.gravityMotionList = this.celestialMotions.filter((m) => m.def.mu !== 0);
    this.atmosphereMotionList = this.celestialMotions.filter(
      (m) => m instanceof OrbitingMotion && m.def.atmosphere !== undefined,
    );
    this.eciTransform = new EciTransform(origin.motion);
    this.referenceFrames = new ReferenceFrames(this.celestialMotions, this.eciTransform);
    // 天体1体ぶんの値は運動が答えるので、その供給源(ECI 変換器・暦)はここで1度だけ配る。
    for (const motion of this.celestialMotions) motion.bindEciTransform(this.eciTransform);
    if (ephemerisPoints !== null) bindEphemerides(this.celestialMotions, ephemerisPoints);
    this.entitiesById = new Map(entities.map((b) => [b.id, b]));
    this.orderedEntities = orderedEntitiesOf(entities);
    this.starEntity = entities.find((entity) => entity.view.stellarLight !== null) ?? null;
    const stellarLight = this.starEntity?.view.stellarLight ?? null;
    this.stellarLightSource = this.starEntity === null || stellarLight === null
      ? null : { motion: this.starEntity.motion, stellarLight };
  }

  // シーンと、光源・影・大気の書き込み先(RenderPipeline が所有)を受け取り、全天体の
  // メッシュ・星野・グリッドをシーンへ登録する。1度だけ呼ぶ — update / sync はこの後でないと
  // 呼べない。
  build(scene: THREE.Scene, illuminationTargets: IlluminationTargets): void {
    this.scene = scene;
    this.illumination = new CelestialIllumination(
      this, this.entities, this.stellarLightSource, illuminationTargets);
    // 天体に付随する線・星野・グリッド。
    this.orbitGuideLines = new OrbitGuideLines(scene, this);
    this.zeroVelocityLines = new ZeroVelocityLines(scene, this);
    this.stars = createStars();
    scene.add(this.stars.mesh);
    this.celestialGrid = new CelestialGrid(scene);
    this.scaleGrid = new ScaleGridView(scene);
    this.ringMaterials = new RingMaterials(
      illuminationTargets.bodyShadow, illuminationTargets.sunLight);
    for (const body of this.entities) body.view.build(body.motion, scene, this.ringMaterials);
  }

  // ---------------------------------------------------------------- 天体の口

  // 天体 id の個体。未登録の id を渡すと例外になる。
  entityOf(id: string): CelestialEntity {
    const entity = this.entitiesById.get(id);
    if (entity === undefined) throw new Error(`CelestialSystem: 登録されていない天体 id: ${id}`);
    return entity;
  }

  find(id: string): CelestialEntity | null { return this.entitiesById.get(id) ?? null; }

  has(id: string): boolean { return this.entitiesById.has(id); }

  // 天体 id の表示名。未登録の id はそのまま返す(架空天体のラベルを例外で止めない)。
  nameOf(id: string): string { return this.entitiesById.get(id)?.name ?? id; }

  // 主星の天体 id。恒星を持たない星系では null。
  get starId(): string | null { return this.starEntity?.id ?? null; }

  // ECI の原点に静止している天体の id。
  get originId(): string { return this.origin.id; }

  // ---------------------------------------------------------------- 系の所属

  // 天体の木を親子関係と重力の効き方から辿り、「何がどの系に属するか」「いまどの系にいるか」を
  // 答える。

  // focusId と同じ親を持つ天体・その親・focusId 自身の id 集合。focusId 未指定なら空集合。
  sameSystemIds(focusId: string | undefined): ReadonlySet<string> {
    if (focusId === undefined) return new Set();
    const parent = this.find(focusId)?.motion.primary?.id ?? null;
    const ids = new Set<string>([focusId]);
    if (parent !== null) ids.add(parent);
    for (const motion of this.celestialMotions) {
      const p = motion.primary?.id ?? null;
      if (p === focusId || (parent !== null && p === parent)) ids.add(motion.id);
    }
    return ids;
  }

  // position の主引力天体が、focus 天体と同じ惑星系に属するか。衛星をフォーカスした場合は親惑星を
  // 系の代表として扱う。天体以外(艦船・固定点など)へフォーカスしている場合は、どの天体系を表示
  // するかを恣意的に決めないため常に真。
  isPositionInFocusedSystem(focusId: string | undefined, position: Vec3, pivot: number): boolean {
    const focus = focusId === undefined ? undefined : this.find(focusId)?.motion;
    if (focus === undefined) return true;

    const systemFocusId = focus.kind === 'satellite' ? focus.primary?.id ?? null : focus.id;
    if (systemFocusId === null) return false;
    const initial = strongestAttractor(position, this.celestialMotions, pivot).id;
    // 太陽を直接周回中でどの惑星系にも属さない対象は、どの惑星がフォーカスされていても常に含める。
    if (this.find(initial)?.motion.kind === 'star') return true;
    return this.ancestorsOf(initial).includes(systemFocusId);
  }

  // 天体 id あるいはラグランジュ点 id の親。undefined は id が不正/古いこと、null は恒星など
  // 親を持たない天体を表す。ラグランジュ点は id の親部分へ戻してから引く。
  bodyParentId(id: string): string | null | undefined {
    const lagrangeParent = isLagrangeId(id) ? lagrangeParentId(id) : undefined;
    if (lagrangeParent !== undefined) return this.has(lagrangeParent) ? lagrangeParent : undefined;
    return this.find(id)?.motion.primary?.id ?? (this.has(id) ? null : undefined);
  }

  // focusId の親を辿って主星まで遡った id の列(focusId 自身を含む)。
  ancestorsOf(focusId: string): readonly string[] {
    const chain: string[] = [];
    let cur: string | null = focusId;
    // 循環した親子定義でも止まるよう、登録数を上限にする。
    for (let i = 0; cur !== null && i <= this.entities.length; i++) {
      if (chain.includes(cur)) break;
      chain.push(cur);
      cur = this.find(cur)?.motion.primary?.id ?? null;
    }
    return chain;
  }

  // id から主星まで遡った id の列。未登録の id(生存中の重力天体)なら、その id 1つだけを返す。
  chainFrom(id: string): readonly string[] {
    return this.has(id) ? this.ancestorsOf(id) : [id];
  }

  // cameraPos で最も強く重力を及ぼす天体から主星まで遡った id の列(その天体自身を含む)。
  systemChainAt(cameraPos: Vec3, pivot: number): readonly string[] {
    if (this.entities.length === 0) return [];
    return this.chainFrom(strongestAttractor(cameraPos, this.celestialMotions, pivot).id);
  }

  // chain の列に、各天体の子(恒星の子は除く)を合わせた集合。近い順・各天体→その子の順に並ぶ
  // 配列で返す。
  membersFrom(chain: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of chain) {
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
      // 主天体を持たない = 恒星(か未登録)。恒星の子は足さない — 足すと太陽を含む列で
      // 全惑星が並んでしまう。
      if ((this.find(id)?.motion.primary ?? null) === null) continue;
      for (const child of this.celestialMotions) {
        if (seen.has(child.id) || (child.primary?.id ?? null) !== id) continue;
        seen.add(child.id);
        result.push(child.id);
      }
    }
    return result;
  }

  // systemChainAt の列に、各天体の子(恒星の子は除く)を合わせた集合。
  systemMembersAt(cameraPos: Vec3, pivot: number): readonly string[] {
    return this.membersFrom(this.systemChainAt(cameraPos, pivot));
  }

  // ---------------------------------------------------------- 系レベルの物理

  // 重力源天体の運動(mu が 0 でないもの、宣言順)。
  get gravityMotions(): readonly CelestialMotion[] { return this.gravityMotionList; }

  // 大気を持つ天体の運動(宣言順)。
  get atmosphereMotions(): readonly CelestialMotion[] { return this.atmosphereMotionList; }

  // 天体 id の運動。未登録の id を渡すと例外になる。
  motionOf(id: string): CelestialMotion { return this.entityOf(id).motion; }

  // 天体 id の運動。未登録の id では null。
  findMotion(id: string): CelestialMotion | null { return this.entitiesById.get(id)?.motion ?? null; }

  // 天体 id の分類。未登録の id では null。
  bodyClassOf(id: string): CelestialClass | null { return this.entitiesById.get(id)?.bodyClass ?? null; }

  // 天体 id の、pivot で厳密に引いた値から時刻 t へ2次外挿した ECI 位置・速度。t を省くと
  // pivot 自身の厳密な値。|t − pivot| は積分1歩の幅程度に収めること。
  stateAt(id: string, pivot: number, t: number = pivot): KinematicState {
    return this.motionOf(id).stateAt(pivot, t);
  }

  // 座標系の同一性(同じ対に同じ参照)と、天体でない基準の解決。
  get frames(): ReferenceFrames { return this.referenceFrames; }

  // ECI の点 r から見た恒星方向の単位ベクトル。恒星が無い星系では無害な既定方向(+X)を返す。
  sunDirFrom(r: Vec3, t: number): Vec3 {
    const star = this.starEntity;
    return star === null ? v3(1, 0, 0) : norm(sub(this.stateAt(star.id, t).r, r));
  }

  // 星系の再構築に要る値のスナップショット(セーブ用)。phaseOffsets は構築時に受け取った
  // record をそのまま返す(明示 0 のキーを落とさない)。
  serialize(): { readonly phaseOffsets: PhaseOffsets; readonly earthSpinPhase0: number | undefined } {
    return { phaseOffsets: { ...this.phaseOffsets }, earthSpinPhase0: this.earthSpinPhase0() };
  }

  // 天体窓の時刻キャッシュのヒット/ミス累計。
  perfCounts(): { timeCacheHits: number; timeCacheMisses: number } {
    let time = this.eciTransform.cacheStats;
    for (const motion of this.celestialMotions) time = addTimeCacheStats(time, motion.cacheStats);
    return { timeCacheHits: time.hits, timeCacheMisses: time.misses };
  }

  // 軌道ガイドタブ(表示パネル5.2節)の設定。変更のたびに渡す。
  setOrbitGuideSettings(settings: OrbitGuideSettings): void {
    this.orbitGuideSettings = settings;
    this.orbitGuideLines.setSettings(settings);
    this.zeroVelocityLines.setSettings(settings.zeroVelocity);
  }

  // 天球グリッド(表示パネル5.1節)の設定。変更のたびに渡す。
  setGridVisibility(visibility: CelestialGridVisibility): void {
    this.gridVisibility = visibility;
  }

  // 表示中の参照軌道線を、当たり判定用の ECI 点列として列挙する。
  referenceOrbitSamples(count: number): readonly {
    readonly id: string;
    readonly points: readonly Vec3[];
  }[] {
    return this.entities.flatMap(({ id, view }) => {
      const points = view.referenceLineSamples(count);
      return points.length < 2 ? [] : [{ id, points }];
    });
  }

  // ラグランジュ点まわりの軌道ガイド線。
  get orbitGuide(): OrbitGuideLines { return this.orbitGuideLines; }

  // ECI の極軸を自転軸とする天体(この座標系を定義している天体)の自転初期位相(セーブ用)。
  // その天体が星系に無ければ undefined。
  private earthSpinPhase0(): number | undefined {
    const pole = this.entities.find(({ motion }) => (
      'pole' in motion.def && motion.def.pole?.kind === 'eciPole'
    ));
    return pole?.motion.spinPhase0;
  }

  // 天体ビュー・星・照明・影・参照線・天球グリッドを、この1フレームの表示状態に同期する。
  // visibilityPolicy はマップビューでは非 null、戦闘ビューでは null。描かれる対象と選べる対象が
  // 同じ判定から出るよう、同じフレームの update 位相で確定させたものを渡す。
  sync(
    floatingOrigin: FloatingOrigin,
    displayTime: number,
    cameraSystem: CameraSystem,
    graphics: GraphicsSettingsData,
    style: RenderStyle,
    mapDisplay: MapDisplayToggles,
    visibilityPolicy: MapVisibilityPolicy | null,
    markers: MarkerSlots,
  ): void {
    const star = this.stellarLightSource;
    for (const body of this.entities) {
      const visible = visibilityPolicy === null || visibilityPolicy.body(body.id).category;
      body.view.sync(
        body.motion, floatingOrigin, displayTime, cameraSystem, star, graphics, style, visible,
      );
    }
    this.illumination.sync(
      floatingOrigin, displayTime, cameraSystem, graphics, visibilityPolicy);

    // 露出に順応しない星殻と点群は、露出の基準が確定した後の係数を受け取る。
    const fixedBrightnessScale = this.illumination.fixedBrightnessScale;
    const starPos = star === null ? null : star.motion.stateAt(displayTime).r;
    const pointField = this.pointFieldView;
    const pointFieldVisible = cameraSystem.view === 'map' && graphics.pointField
      && mapDisplay.smallBodyVisible;
    if (pointField !== null && pointFieldVisible && starPos !== null) {
      this.buildPointField(pointField);
      pointField.sync(floatingOrigin, displayTime, starPos, fixedBrightnessScale);
    } else if (this.pointFieldBuilt) {
      pointField?.hide();
    }
    this.syncStars(fixedBrightnessScale, this.gridVisibility.stars);
    const geostationaryOrbitVisible = this.orbitGuideSettings.geostationary;
    this.syncReferenceLines(
      displayTime, floatingOrigin, visibilityPolicy,
      cameraSystem.activeCamera, cameraSystem.activeCameraPos);
    // 地球の静止軌道リングなど、天体固有のマップ付随表示。
    for (const body of this.entities) {
      const categoryVisible = visibilityPolicy === null
        || visibilityPolicy.body(body.id).category;
      body.view.syncMapOverlay(
        body.motion, floatingOrigin, displayTime, cameraSystem, markers, this.celestialMotions,
        cameraSystem.view === 'map' && geostationaryOrbitVisible && categoryVisible);
    }
    this.orbitGuideLines.sync(style, displayTime, cameraSystem.view, floatingOrigin, cameraSystem.activeCamera);
    this.zeroVelocityLines.sync(displayTime, cameraSystem.view, floatingOrigin, cameraSystem.activeCamera);
    this.celestialGrid.sync(
      style, this.gridVisibility, cameraSystem.activeCamera,
      CELESTIAL_SHELL_SCALE);
    this.scaleGrid.sync(floatingOrigin, displayTime, cameraSystem, this, this.gridVisibility);
  }

  // このフレームに積雲殻を描く天体の雲場を焼く。
  public bakeClouds(renderer: WebGPURenderer, displayTime: number): void {
    for (const body of this.entities) body.view.bakeClouds(renderer, displayTime);
  }

  // 星球は描画原点(= カメラ)に固定した半径の殻。
  private syncStars(fixedBrightnessScale: number, visible: boolean): void {
    this.stars.mesh.position.set(0, 0, 0);
    this.stars.mesh.scale.setScalar(CELESTIAL_SHELL_SCALE);
    this.stars.mesh.visible = visible;
    this.stars.setFixedBrightnessScale(fixedBrightnessScale);
  }

  // 参照軌道線を出すかを表示ポリシーから決め、毎フレームの enabled 値として個体へ渡す。
  // cameraPos は個体がフェードを測る基準(カメラの真の ECI 位置)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, visibilityPolicy: MapVisibilityPolicy | null,
    camera: THREE.Camera, cameraPos: Vec3,
  ): void {
    for (const body of this.entities) {
      const visible = visibilityPolicy !== null
        && body.motion.kind !== 'star'
        && visibilityPolicy.body(body.id).orbit;
      body.view.syncReferenceLine(
        body.motion, this.scene, simTime, fo, camera, cameraPos, visible,
      );
    }
  }

  // 最初にマップへ描くときにシーンへ登録する。
  private buildPointField(pointField: PointFieldView): void {
    if (this.pointFieldBuilt) return;
    this.pointFieldBuilt = true;
    pointField.build(this.scene);
  }

  // 天体ビュー・星殻・グリッド・点群・参照線を残さず解放する。
  dispose(): void {
    this.orbitGuideLines.dispose();
    this.zeroVelocityLines.dispose();
    // 星殻・天球グリッド・縮尺グリッド。
    this.stars.mesh.removeFromParent();
    this.stars.dispose();
    this.celestialGrid.dispose();
    this.scaleGrid.dispose();
    // 各天体ビュー(参照軌道線を含む)と、マップを一度でも開いていれば生成済みの小天体点群。
    for (const body of this.entities) body.view.dispose();
    if (this.pointFieldBuilt) this.pointFieldView?.dispose();
    this.ringMaterials.dispose();
  }
}
