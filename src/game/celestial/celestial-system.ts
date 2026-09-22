// 天体系(天体ビュー・星・天球グリッド・参照軌道線・照明)の構築と毎フレームの同期。天体の索引と、
// 系の所属・系レベルの物理量を答える。
import type * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { type CelestialMotion, OrbitingMotion, PlanetMotion } from '../../physics/celestial-motion';
import { isStar, type StarCelestialBody } from '../../physics/celestial-body-def';
import { type EphemerisPoints, ephemerisPointOf } from '../../physics/ephemeris/point';
import { EciTransform } from '../../physics/eci-transform';
import { ReferenceFrames } from './reference-frames';
import { addTimeCacheStats } from '../../physics/time-ring';
import type { KinematicState } from '../../physics/kinematic-state';
import { norm, sub, v3, type Vec3 } from '../../math/vec3';
import { CELESTIAL_SHELL_SCALE, createStars, type Stars } from '../../render/stars';
import { CelestialGrid, type CelestialGridVisibility } from '../../render/celestial-grid';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { ScaleGridView } from './scale-grid-view';
import { focusTargetId } from '../viewer/focus-target';
import { CelestialIllumination, type IlluminationTargets } from '../../render/celestial/celestial-illumination';
import { RingMaterials } from '../../render/celestial/ring';
import type { CelestialEntity } from './celestial-entity/celestial-entity';
import type { StellarLightSource } from '../../render/celestial/celestial-entity/celestial-view';
import { OrbitGuideModel } from './orbit-guide/orbit-guide-model';
import { ZeroVelocityModel } from './orbit-guide/zero-velocity-model';
import { OrbitGuideView, type VisibleGuideLine } from '../../render/celestial/orbit-guide/orbit-guide-view';
import { ZeroVelocityView } from '../../render/celestial/orbit-guide/zero-velocity-view';
import type { OrbitGuideSettings } from '../viewer/orbit-guide-settings';
import type { TdbJulianDate } from '../../physics/time';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MapOverlayLabel } from '../../render/celestial/celestial-entity/celestial-view';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { pointPlacement } from '../marker/marker-placement';
import { isOccluded } from '../../physics/occlusion';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';
import type { PointFieldView } from '../../render/celestial/point-field-view';
import type { GpuTimingSink } from '../../render/gpu-timings';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CelestialBodies } from './celestial-bodies';
import type { FocusCameraSource } from '../viewer/focus-camera-selection';
import type { CelestialClass } from './celestial-entity/celestial-entity-def';
import type { PerfCounts } from '../perf-counts';
import type { ViewMode } from '../view/view-mode';
import {
  ancestorsOf, bodyParentId, chainFrom, isPositionInFocusedSystem, membersFrom, orderedEntitiesOf,
  sameSystemIds, systemChainAt, systemMembersAt,
} from './celestial-system-query';

// 数値暦が収録している点を、結び先のノードへ割り当てる（バインドする）。暦は id ごとに天体本体を収録している場合と
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

export class CelestialSystem implements CelestialBodies {
  private readonly overlayDeclarations: MarkerDeclaration[] = [];
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
  public readonly celestialMotions: readonly CelestialMotion[];
  // 親を先に、その子を続けて並べた天体の列と、主星を 0 とする階層の深さ。
  public readonly orderedEntities: readonly { readonly entity: CelestialEntity; readonly depth: number }[];
  // 主星の運動。恒星を持たない星系では null。
  private readonly starMotion: StarCelestialBody | null;
  // 主星が放つ光。恒星を持たないか、主星の表示が光を放たない星系では null。
  private readonly stellarLightSource: StellarLightSource | null;
  // 天体の値を ECI へ移す変換器。原点天体の選択の正本。
  private readonly eciTransform: EciTransform;
  // 座標系の同一性。entities の motion から組む。
  private readonly referenceFrames: ReferenceFrames;

  // mu が 0 でない天体と、大気を持つ天体(いずれも宣言順)。どちらも時刻に依らないので
  // 構築時に確定する。
  private readonly gravityMotionList: readonly CelestialMotion[];
  private readonly atmosphereMotionList: readonly CelestialMotion[];

  // 軌道ガイド線(周期軌道族・リサジュー・地球専用の参照軌道)。
  private readonly orbitGuideModel: OrbitGuideModel;
  private orbitGuideView!: OrbitGuideView;
  // ゼロ速度曲線。
  private readonly zeroVelocityModel: ZeroVelocityModel;
  private zeroVelocityView!: ZeroVelocityView;

  // entities はこの星系の全天体(宣言順)、origin はその中の ECI 中心天体。epoch は simTime=0 が
  // 指す絶対時刻。pointFieldView は小天体の点群(持たない星系では null)、ephemerisPoints は
  // 数値暦が収録している点の一覧。
  public constructor(
    public readonly entities: readonly CelestialEntity[],
    public readonly origin: CelestialEntity,
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
    // 天体1体ぶんの値は運動が答えるので、その供給源(ECI 変換器・暦)はここで1度だけバインド（設定）する。
    for (const motion of this.celestialMotions) motion.bindEciTransform(this.eciTransform);
    if (ephemerisPoints !== null) bindEphemerides(this.celestialMotions, ephemerisPoints);
    this.entitiesById = new Map(entities.map((b) => [b.id, b]));
    this.orderedEntities = orderedEntitiesOf(entities);
    const starMotion = this.celestialMotions.find(isStar) ?? null;
    this.starMotion = starMotion;
    // 主星に決まった天体の表示が光を放たなければ、主星はあっても光源は置かない。
    const stellarLight = starMotion === null ? null : this.entityOf(starMotion.id).view.stellarLight;
    this.stellarLightSource = starMotion === null || stellarLight === null
      ? null : { motion: starMotion, stellarLight };
    this.orbitGuideModel = new OrbitGuideModel(this);
    this.zeroVelocityModel = new ZeroVelocityModel(this);
  }

  // シーンと、光源・影・大気の書き込み先を受け取り、全天体のメッシュ・星野・グリッドをシーンへ
  // 登録する。1度だけ呼ぶ — sync・bakeClouds はこの後でないと呼べない。
  public build(scene: THREE.Scene, illuminationTargets: IlluminationTargets): void {
    this.scene = scene;
    this.illumination = new CelestialIllumination(this.stellarLightSource, illuminationTargets);
    // 天体に付随する線・星野・グリッド。
    this.orbitGuideView = new OrbitGuideView(scene);
    this.zeroVelocityView = new ZeroVelocityView(scene);
    this.stars = createStars(this.illumination);
    scene.add(this.stars.mesh);
    this.celestialGrid = new CelestialGrid(scene);
    this.scaleGrid = new ScaleGridView(scene);
    this.ringMaterials = new RingMaterials(
      illuminationTargets.bodyShadow, illuminationTargets.sunLight);
    for (const body of this.entities) body.view.build(body.motion, scene, this.ringMaterials);
    this.pointFieldView?.build(scene);
  }

  // ---------------------------------------------------------------- 天体の口

  // 天体 id の個体。未登録の id を渡すと例外になる。
  public entityOf(id: string): CelestialEntity {
    const entity = this.entitiesById.get(id);
    if (entity === undefined) throw new Error(`CelestialSystem: 登録されていない天体 id: ${id}`);
    return entity;
  }

  public find(id: string): CelestialEntity | null { return this.entitiesById.get(id) ?? null; }

  public has(id: string): boolean { return this.entitiesById.has(id); }

  // 天体 id の表示名。未登録の id はそのまま返す(架空天体のラベルを例外で止めない)。
  public nameOf(id: string): string { return this.entitiesById.get(id)?.name ?? id; }

  // 主星の天体 id。恒星を持たない星系では null。
  public get starId(): string | null { return this.starMotion?.id ?? null; }

  // ECI の原点に静止している天体の id。
  public get originId(): string { return this.origin.id; }

  // ---------------------------------------------------------------- 系の所属

  // 天体の木を親子関係と重力の効き方から辿り、「何がどの系に属するか」「いまどの系にいるか」を
  // 答える。

  // focusId と同じ親を持つ天体・その親・focusId 自身の id 集合。focusId 未指定なら空集合。
  public sameSystemIds(focusId: string | undefined): ReadonlySet<string> {
    return sameSystemIds(focusId ?? null, this.celestialMotions, this.entities);
  }

  // position の主引力天体が、focus 天体と同じ惑星系に属するか。衛星をフォーカスした場合は親惑星を
  // 系の代表として扱う。天体以外(艦船・固定点など)へフォーカスしている場合は、どの天体系を表示
  // するかを恣意的に決めないため常に真。
  public isPositionInFocusedSystem(focusId: string | undefined, position: Vec3, pivot: number): boolean {
    return isPositionInFocusedSystem(focusId ?? null, position, pivot, this.celestialMotions, this.entities);
  }

  // 天体 id あるいはラグランジュ点 id の親。undefined は id が不正/古いこと、null は恒星など
  // 親を持たない天体を表す。ラグランジュ点は id の親部分へ戻してから引く。
  public bodyParentId(id: string): string | null | undefined {
    const parentId = bodyParentId(id, this.entities);
    return this.has(id) || parentId !== null ? parentId : undefined;
  }

  // focusId の親を辿って主星まで遡った id の列(focusId 自身を含む)。
  public ancestorsOf(focusId: string): readonly string[] {
    return ancestorsOf(focusId, this.entities);
  }

  // id から主星まで遡った id の列。未登録の id(生存中の重力天体)なら、その id 1つだけを返す。
  public chainFrom(id: string): readonly string[] {
    return chainFrom(id, this.entities);
  }

  // cameraPos で最も強く重力を及ぼす天体から主星まで遡った id の列(その天体自身を含む)。
  public systemChainAt(cameraPos: Vec3, pivot: number): readonly string[] {
    return systemChainAt(cameraPos, pivot, this.celestialMotions, this.entities);
  }

  // chain の列に、各天体の子(恒星の子は除く)を合わせた集合。近い順・各天体→その子の順に並ぶ
  // 配列で返す。
  public membersFrom(chain: readonly string[]): readonly string[] {
    return membersFrom(chain, this.celestialMotions, this.entities);
  }

  // systemChainAt の列に、各天体の子(恒星の子は除く)を合わせた集合。
  public systemMembersAt(cameraPos: Vec3, pivot: number): readonly string[] {
    return systemMembersAt(cameraPos, pivot, this.celestialMotions, this.entities);
  }

  // ---------------------------------------------------------- 系レベルの物理

  // 重力源天体の運動(mu が 0 でないもの、宣言順)。
  public get gravityMotions(): readonly CelestialMotion[] { return this.gravityMotionList; }

  // 大気を持つ天体の運動(宣言順)。
  public get atmosphereMotions(): readonly CelestialMotion[] { return this.atmosphereMotionList; }

  // 天体 id の運動。未登録の id を渡すと例外になる。
  public motionOf(id: string): CelestialMotion { return this.entityOf(id).motion; }

  // 天体 id の運動。未登録の id では null。
  public findMotion(id: string): CelestialMotion | null { return this.entitiesById.get(id)?.motion ?? null; }

  // 天体 id の分類。未登録の id では null。
  public bodyClassOf(id: string): CelestialClass | null { return this.entitiesById.get(id)?.bodyClass ?? null; }

  // 天体 id の、pivot で厳密に引いた値から時刻 t へ2次外挿した ECI 位置・速度。t を省くと
  // pivot 自身の厳密な値。|t − pivot| は積分1歩の幅程度に収めること。
  public stateAt(id: string, pivot: number, t: number = pivot): KinematicState {
    return this.motionOf(id).stateAt(pivot, t);
  }

  // 座標系の同一性(同じ対に同じ参照)と、天体でない基準の解決。
  public get frames(): ReferenceFrames { return this.referenceFrames; }

  // ECI の点 r から見た恒星方向の単位ベクトル。恒星が無い星系では無害な既定方向(+X)を返す。
  public sunDirFrom(r: Vec3, t: number): Vec3 {
    const star = this.starMotion;
    return star === null ? v3(1, 0, 0) : norm(sub(star.stateAt(t).r, r));
  }

  // 天体と地表が答える、デバッグ表示用の狭い計測値をまとめる。
  public perfCounts(): Pick<PerfCounts, 'surfaces'> & { timeCacheHits: number; timeCacheMisses: number } {
    let time = this.eciTransform.cacheStats;
    for (const motion of this.celestialMotions) time = addTimeCacheStats(time, motion.cacheStats);
    const surfaces = this.entities.flatMap((entity) => {
      const diagnostics = entity.view.surfaceDiagnostics;
      return diagnostics === null ? [] : [{ id: entity.id, name: entity.name, diagnostics }];
    });
    return { timeCacheHits: time.hits, timeCacheMisses: time.misses, surfaces };
  }

  // 表示中の参照軌道線を、当たり判定用の ECI 点列として列挙する。
  public referenceOrbitSamples(count: number): readonly {
    readonly id: string;
    readonly points: readonly Vec3[];
  }[] {
    return this.entities.flatMap(({ id, view }) => {
      const points = view.referenceLineSamples(count);
      return points.length < 2 ? [] : [{ id, points }];
    });
  }

  // 軌道ガイド線のモデル。
  public get orbitGuide(): OrbitGuideModel { return this.orbitGuideModel; }

  // 表示中の軌道ガイド線を、当たり判定用の識別情報付き ECI 点列として列挙する。
  public orbitGuideSamples(count: number): readonly VisibleGuideLine[] {
    return this.orbitGuideView.visibleLines(count);
  }

  // 天体ビュー・星・照明・影・参照線・天球グリッドを、この1フレームの表示状態に同期する。nowMs は
  // このフレームの実時刻 [ms]、grid・orbitGuide はこのフレームの表示設定。visibilityPolicy は軌道線を
  // 引く対象を決め、戦闘ビューでは null(引かない)。
  public sync(
    displayTime: number,
    nowMs: number,
    camera: CameraFrame,
    view: ViewMode,
    mapCamera: Pick<FocusCameraSource, 'focus' | 'distance'>,
    mapResolvedFocus: Vec3,
    graphics: GraphicsSettingsData,
    style: RenderStyle,
    grid: CelestialGridVisibility,
    orbitGuide: OrbitGuideSettings,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const floatingOrigin = camera.floatingOrigin;
    const star = this.stellarLightSource;
    for (const body of this.entities) {
      body.view.sync(body.motion, displayTime, nowMs, camera, star, graphics, style);
    }
    // 注視中の天体は、影の濃さをカメラ位置と並べて測る基準点になる。天体でない対象を
    // 注視しているフレームでは持たない。
    const focusId = focusTargetId(mapCamera.focus);
    const focusPosition = focusId === undefined
      ? null : this.findMotion(focusId)?.positionAt(displayTime) ?? null;
    this.illumination.sync(
      this.entities.map((body) => body.illuminationSource()),
      displayTime, camera, graphics, focusPosition, this.sunDirFrom(floatingOrigin.r, displayTime));

    // 露出に順応しない点群は、露出の基準が確定した後の係数を受け取る(星殻は照明から直に引く)。
    const fixedBrightnessScale = this.illumination.fixedBrightnessScale;
    const starPos = this.starMotion?.stateAt(displayTime).r ?? null;
    this.pointFieldView?.sync(
      view === 'map' && graphics.pointField,
      floatingOrigin, displayTime, starPos, fixedBrightnessScale);
    this.stars.sync(grid.stars);
    this.syncReferenceLines(displayTime, camera, visibilityPolicy);
    // 地球の静止軌道リングなど、天体固有のマップ付随表示。ラベルは全天体で同じ id の
    // マーカー1枠を共有するので、最後に返した天体のものだけが残る。
    let overlayLabel: MapOverlayLabel | null = null;
    for (const body of this.entities) {
      overlayLabel = body.view.syncMapOverlay(
        body.motion, displayTime, camera,
        view === 'map' && orbitGuide.geostationary) ?? overlayLabel;
    }
    this.overlayDeclarations.length = 0;
    const overlay = this.overlayDeclarationOf(overlayLabel, camera, displayTime);
    if (overlay !== null) this.overlayDeclarations.push(overlay);
    this.orbitGuideView.sync(
      this.orbitGuideModel.displaysAt(orbitGuide, displayTime, style, view), camera, nowMs);
    this.zeroVelocityView.sync(
      this.zeroVelocityModel.displaysAt(orbitGuide.zeroVelocity, displayTime, view), camera);
    this.celestialGrid.sync(style, grid, camera.camera, CELESTIAL_SHELL_SCALE, camera.viewport);
    this.scaleGrid.sync(displayTime, camera, view, mapCamera, mapResolvedFocus, this, grid);
  }

  // 天体固有のマップ付随表示が、このフレームに出す文字マーカーの宣言。
  public get markerDeclarations(): readonly MarkerDeclaration[] { return this.overlayDeclarations; }

  // 付随表示のラベルを、投影と遮蔽の判定を通してマーカーの宣言へ組む。出さないフレームは null。
  private overlayDeclarationOf(
    label: MapOverlayLabel | null, camera: CameraFrame, displayTime: number,
  ): MarkerDeclaration | null {
    if (label === null) return null;
    const { x, y, front, dist } = pointPlacement(label.pos, camera.project, camera.position);
    if (!front || isOccluded(camera.position, label.pos, this.celestialMotions, displayTime)) return null;
    return {
      id: 'geolabel', cls: 'mk-geolabel', sym: label.text, x, y, front, dist,
      opacity: label.opacity, fixedLabel: true, priority: MARKER_PRIORITY.ORBITAL_NODE,
    };
  }

  // このフレームに積雲殻を描く天体の雲場を焼く。
  public bakeClouds(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    for (const body of this.entities) body.view.bakeClouds(renderer, displayTime, gpu);
  }

  // 参照軌道線を出すかを表示ポリシーから決め、毎フレームの enabled 値として個体へ渡す。
  private syncReferenceLines(
    displayTime: number, camera: CameraFrame, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    for (const body of this.entities) {
      const visible = visibilityPolicy !== null
        && body.motion.kind !== 'star'
        && visibilityPolicy.body(body.id).orbit;
      body.view.syncReferenceLine(body.motion, this.scene, displayTime, camera, visible);
    }
  }

  // 天体ビュー・星殻・グリッド・点群・参照線を残さず解放する。
  public dispose(): void {
    this.orbitGuideView.dispose();
    this.zeroVelocityView.dispose();
    // 星殻・天球グリッド・縮尺グリッド。
    this.stars.mesh.removeFromParent();
    this.stars.dispose();
    this.celestialGrid.dispose();
    this.scaleGrid.dispose();
    // 各天体ビュー(参照軌道線を含む)と、小天体の点群。
    for (const body of this.entities) body.view.dispose();
    this.pointFieldView?.dispose();
    this.ringMaterials.dispose();
  }
}
