// 天体系(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { CelestialBodyDef, CelestialMotion, PhaseOffsets } from '../../physics/celestial-motion';
import { AbsoluteEphemeris } from '../../physics/absolute-ephemeris';
import { CelestialBodyWindows } from '../../physics/celestial-body-windows';
import { ReferenceFrames } from '../../physics/reference-frames';
import { CelestialBody } from '../../physics/celestial-body';
import { KinematicState } from '../../physics/kinematic-state';
import type { TdbJulianDate } from '../../physics/time';
import { norm, sub, v3, Vec3 } from '../../math/vec3';
import type { MarkerManager } from '../marker/marker-manager';
import { OrbitLine } from '../lines/orbit-line';
import { celestialShellScale, createStars, Stars } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility } from '../../render/celestial-grid';
import { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import { FloatingOrigin } from '../camera/floating-origin';
import { ScaleGridView } from './scale-grid-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';
import type { PointFieldView } from './point-field-view';
import {
  REFERENCE_STAR_RADIANT_INTENSITY, STARLESS_SUN_COLOR, STARLESS_SUN_DISTANCE,
  STARLESS_SUN_RADIUS, SunLight,
} from '../../render/pipeline/sun-light';
import type { Exposure } from '../../render/pipeline/exposure';
import type { PlanetLightSource } from '../../render/pipeline/lighting/planet-light-source';
import { ambientFraction, type AmbientSource } from '../../render/pipeline/lighting/ambient-source';
import { selectPlanetLights } from '../../render/pipeline/lighting/planet-light-select';
import { DEFAULT_ALBEDO } from '../../render/celestial-albedo';
import type { Occluder, SunOcclusion } from '../../render/pipeline/sun-occlusion';
import {
  selectOccluders, selectRingShadow, type RingShadowCandidate,
} from '../../render/pipeline/sun-occlusion-select';
import type { AtmospherePass } from '../../render/pipeline/atmosphere-pass';
import { atmosphereDraws } from '../../render/atmosphere';
import { LIT_OPAQUE_LAYER } from '../../render/pipeline/lit-layer';
import { CelestialEntity } from './celestial-entity/celestial-entity';
import { StarEntity } from './celestial-entity/star-entity';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import { OrbitGuideLines } from './orbit-guide/orbit-guide-lines';
import { ZeroVelocityLines } from './orbit-guide/zero-velocity-lines';
import { DEFAULT_ORBIT_GUIDE_SETTINGS, OrbitGuideSettings } from './orbit-guide/orbit-guide-settings';

const ZERO_VECTOR = new THREE.Vector3();
const UP_VECTOR = new THREE.Vector3(0, 1, 0);

export class CelestialSystem {
  private scene!: THREE.Scene;
  // **絵に出ない光源。** three はカメラのチャンネルと重なる光源が 1 つも無いとライティング
  // モデルごと組まないので(NodeMaterial.setupLighting)、受け手を真っ黒にしないために
  // 1 個だけ置いてある。マテリアルパスは direct() を無効化し indirect() を照度バッファの
  // 読み出しへ差し替えるため、この光源の色も強度もどこからも読まれない — 光の値の正本は
  // SunLight ただ 1 つ。
  private lightingAnchor!: THREE.AmbientLight;
  private stars!: Stars;
  celestialGrid!: CelestialGrid;
  private scaleGrid!: ScaleGridView;
  private sunLight!: SunLight;
  private exposure!: Exposure;
  private sunOcclusion!: SunOcclusion;
  private planetLight!: PlanetLightSource;
  private ambient!: AmbientSource;
  private atmosphere!: AtmospherePass;
  private readonly entitiesById: ReadonlyMap<string, CelestialEntity>;
  // 全天体の運動(entities と同じ宣言順)。THREE 非依存の層(system-membership 等)へ列挙を
  // 渡すときはこれを使う。
  readonly motions: readonly CelestialMotion[];
  // 主星の個体。恒星を持たない星系では null。
  private readonly starEntity: StarEntity | null;
  // 座標系の同一性と、同一時刻の天体窓。どちらも entities の motion から組む。
  private readonly referenceFrames: ReferenceFrames;
  private readonly bodyWindows: CelestialBodyWindows;

  // 点群をシーンへ登録済みか。マップへ入るまで登録しない。
  private pointFieldBuilt = false;

  // ラグランジュ点まわりの周期・準周期軌道のガイド線(表示パネルの軌道ガイドタブ、静止軌道を除く)。
  private orbitGuideLines!: OrbitGuideLines;
  // ゼロ速度曲線(ガイドタブ5.3節)。
  private zeroVelocityLines!: ZeroVelocityLines;
  // 軌道ガイドタブの正本の鏡映し。静止軌道リング・ラベルの表示可否だけをここから読む。
  private orbitGuideSettings: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;

  // entities はこの星系の全天体(宣言順。重力源配列・一覧の順序もこれで決まる)、origin は
  // その中の ECI 中心天体。phaseOffsets は motion を組むのに使った初期位相(セーブでそのまま
  // 返すために保持する)。epoch は simTime=0 が指す絶対時刻で、この星系はすべてそれを基準に
  // 組まれている。THREE の資源はここでは受け取らない — build(scene, …) が登録する。
  // pointFieldView はこの星系に付随する小天体の点群(持たない星系では null)。マップへ入るまで
  // 資源を確保しない表示なので、シーンへの登録は最初のマップ更新まで遅らせる。
  // absoluteSource は高精度暦の供給源。天体1体ぶんへ切り分けて各 motion へ配る。
  constructor(
    readonly entities: readonly CelestialEntity[],
    readonly origin: CelestialEntity,
    private readonly phaseOffsets: PhaseOffsets,
    readonly epoch: TdbJulianDate,
    private readonly pointFieldView: PointFieldView | null = null,
    absoluteSource: AbsoluteEphemeris | null = null,
  ) {
    this.motions = entities.map((b) => b.motion);
    this.bodyWindows = new CelestialBodyWindows(this.motions, origin.motion);
    this.referenceFrames = new ReferenceFrames(this.bodyWindows, this.motions, origin.motion);
    for (const entity of entities) entity.bindWindows(this.bodyWindows);
    if (absoluteSource !== null) {
      for (const motion of this.motions) motion.bindEphemeris(absoluteSource.bodyEphemerisOf(motion.id));
    }
    this.entitiesById = new Map(entities.map((b) => [b.id, b]));
    this.starEntity = entities.find((b): b is StarEntity => b instanceof StarEntity) ?? null;
  }

  // シーンとライティングパスの値オブジェクト(RenderPipeline が所有)を受け取り、全天体の
  // メッシュ・星野・グリッド・光源アンカーをシーンへ登録する。Game の構築中に1度だけ呼ぶ —
  // update / sync はこの後でないと呼べない。
  build(
    scene: THREE.Scene, sunLight: SunLight, exposure: Exposure, sunOcclusion: SunOcclusion,
    planetLight: PlanetLightSource, ambient: AmbientSource, atmosphere: AtmospherePass,
  ): void {
    this.scene = scene;
    this.sunLight = sunLight;
    this.exposure = exposure;
    this.sunOcclusion = sunOcclusion;
    this.planetLight = planetLight;
    this.ambient = ambient;
    this.atmosphere = atmosphere;
    this.orbitGuideLines = new OrbitGuideLines(scene, this);
    this.zeroVelocityLines = new ZeroVelocityLines(scene, this);
    this.lightingAnchor = new THREE.AmbientLight();
    scene.add(this.lightingAnchor);
    // レンダラーは光源自身の layers とカメラの layers が重ならないと光源をそのカメラの描画対象
    // から除外する(ライティングモデルの呼び出し自体が起きなくなる)。マテリアルパスは自身の
    // render() の間だけカメラを LIT_OPAQUE_LAYER 単独へ絞るため、同チャンネルへも加えておく。
    this.lightingAnchor.layers.enable(LIT_OPAQUE_LAYER);
    this.stars = createStars();
    scene.add(this.stars.mesh);
    this.celestialGrid = new CelestialGrid(scene);
    this.scaleGrid = new ScaleGridView(scene);
    for (const body of this.entities) body.build(scene, sunOcclusion, sunLight);
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

  // 主星の個体。恒星を持たない星系では null。
  get star(): StarEntity | null { return this.starEntity; }

  // 全登録天体の定義(宣言順)。
  get defs(): readonly CelestialBodyDef[] { return this.entities.map((b) => b.def); }

  // ---------------------------------------------------------- 系レベルの物理

  // 指定時刻の全登録天体(宣言順)。同一 t には同一の配列参照が返るので、**呼び出し側は
  // この配列と要素を書き換えてはならない**(gravityAttractorsAt / atmosphere… も同じ)。
  celestialBodiesAt(t: number): readonly CelestialBody[] { return this.windows.celestialBodiesAt(t); }

  // 指定時刻の重力源天体(mu が 0 でないもの、宣言順)。
  gravityAttractorsAt(t: number): readonly CelestialBody[] { return this.windows.gravityAttractorsAt(t); }

  // 1天体ぶんの時刻 t での重力源表現。予測弧の候補供給(FutureCelestialBodyProvider)もこれで満たす。
  celestialBodyAt(id: string, t: number): CelestialBody { return this.windows.bodyAt(id, t); }

  // 天体 id の、pivot で厳密に引いた値から時刻 t へ2次外挿した ECI 位置・速度。t を省くと
  // pivot 自身の厳密な値。
  stateAt(id: string, pivot: number, t: number = pivot): KinematicState {
    return this.windows.stateAt(id, pivot, t);
  }

  // 指定時刻の大気を持つ天体(宣言順)。抗力を掛ける1体を選ぶ側が引く窓。
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[] {
    return this.windows.atmosphereCelestialBodiesAt(t);
  }

  // 座標系の同一性(同じ対に同じ参照)と、天体でない基準の解決。
  get frames(): ReferenceFrames { return this.referenceFrames; }

  // 同一時刻の天体窓。積分・計画など、窓だけを要する層へはこれを渡す。
  get windows(): CelestialBodyWindows { return this.bodyWindows; }

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

  // 負荷確認ウィンドウが読む、天体窓の時刻キャッシュのヒット/ミス累計。
  perfCounts(): {
    celestialBodiesCacheHits: number; celestialBodiesCacheMisses: number;
    timeCacheHits: number; timeCacheMisses: number;
  } {
    const celestialBodies = this.windows.celestialBodiesStats;
    const time = this.windows.stats;
    return {
      celestialBodiesCacheHits: celestialBodies.hits, celestialBodiesCacheMisses: celestialBodies.misses,
      timeCacheHits: time.hits, timeCacheMisses: time.misses,
    };
  }

  // 表示時刻 t の点群の位置を更新する。
  update(t: number, overviewMode: boolean, graphics: GraphicsSettingsData): void {
    const star = this.starEntity;
    const pointField = this.pointFieldView;
    if (!overviewMode || star === null || pointField === null || !graphics.pointField) return;
    this.buildPointField(pointField);
    pointField.update(t, true, this.stateAt(star.id, t).r);
  }

  // 軌道ガイドタブ(表示パネル5.2節)の設定。ゲーム側が変更のたびに渡す。
  setOrbitGuideSettings(settings: OrbitGuideSettings): void {
    this.orbitGuideSettings = settings;
    this.orbitGuideLines.setSettings(settings);
    this.zeroVelocityLines.setSettings(settings.zeroVelocity);
  }

  // 公転天体1体につき1本の参照軌道線(右クリックの当たり判定向け)。線を持つ個体だけを列挙する。
  get referenceOrbitLines(): readonly { readonly id: string; readonly line: OrbitLine }[] {
    return this.entities.flatMap((b) => (b.referenceLine === null ? [] : [{ id: b.id, line: b.referenceLine }]));
  }

  // ラグランジュ点まわりの軌道ガイド線(右クリックの当たり判定向け)。
  get orbitGuide(): OrbitGuideLines { return this.orbitGuideLines; }

  // ECI の極軸を自転軸とする天体(この座標系を定義している天体)の自転初期位相(セーブ用)。
  // その天体が星系に無ければ undefined。
  earthSpinPhase0(): number | undefined {
    const pole = this.entities.find((b) => 'pole' in b.def && b.def.pole?.kind === 'eciPole');
    return pole?.motion.spinPhase0;
  }

  // 天体ビュー・星・照明・遮蔽・参照線・天球グリッドを、この1フレームの表示状態に同期する。
  // visibilityPolicy は**マップビューのとき非 null、戦闘ビューのとき null** を渡す。描かれる
  // 対象と選べる対象が同じ判定から出るよう、同じフレームの update 位相で確定させたものを渡す。
  sync(
    floatingOrigin: FloatingOrigin,
    displayTime: number,
    cameraSystem: CameraSystem,
    graphics: GraphicsSettingsData,
    style: RenderStyle,
    gridVisibility: CelestialGridVisibility,
    visibilityPolicy: MapVisibilityPolicy | null,
    markerManager: MarkerManager | null,
  ): void {
    const star = this.starEntity;
    const starMotion = star?.motion ?? null;
    for (const body of this.entities) {
      body.setVisible(visibilityPolicy === null || visibilityPolicy.body(body.id).category);
      body.sync(floatingOrigin, displayTime, cameraSystem, star, graphics, style);
    }
    // 主星が無いレジストリでは、描画原点から見た恒星方向へ 1 天文単位の位置に半径 0 の光源を置く
    // (基準強度どおりの放射照度が届き、遮蔽パスは誰も遮らないと答える)。
    const sunPos = starMotion === null
      ? this.toThreeNormal(this.sunDirFrom(floatingOrigin.r, displayTime))
        .multiplyScalar(STARLESS_SUN_DISTANCE)
      : floatingOrigin.RtoThreeV3(this.stateAt(starMotion.id, displayTime).r);
    // 露出の順応と天体照の選定の基準点。カメラ位置ではなく注視点から取る —
    // マップビューではカメラが太陽系の外にいることがあり、そこを基準にすると露出が発散する。
    const reference = floatingOrigin.RtoThreeV3(cameraSystem.activeViewpoint.lookTarget);
    // 恒星を持たない星系では、1 天文単位の位置に置いた基準の恒星ぶんの光が届くものとして扱う。
    const starIntensity = star?.radiantIntensity ?? REFERENCE_STAR_RADIANT_INTENSITY;
    this.exposure.setReference(reference, sunPos, starIntensity);
    this.sunLight.set(
      sunPos, star?.def.radius ?? STARLESS_SUN_RADIUS,
      star?.color ?? STARLESS_SUN_COLOR, starIntensity);
    this.ambient.setFraction(ambientFraction(cameraSystem.overviewMode, graphics));
    this.syncPlanetLights(floatingOrigin, displayTime, cameraSystem);
    this.syncOcclusion(floatingOrigin, displayTime, cameraSystem, graphics);
    this.syncAtmosphere(floatingOrigin, displayTime, cameraSystem, graphics);

    const fixedBrightnessScale = this.exposure.fixedBrightnessScale;
    const pointField = this.pointFieldView;
    if (pointField !== null && cameraSystem.overviewMode && star !== null && graphics.pointField) {
      this.buildPointField(pointField);
      pointField.sync(
        floatingOrigin, true, cameraSystem.mapDisplayToggles.smallBodyVisible, fixedBrightnessScale,
      );
    } else if (this.pointFieldBuilt) {
      pointField?.sync(floatingOrigin, false, true, fixedBrightnessScale);
    }
    this.syncStars(cameraSystem, fixedBrightnessScale, gridVisibility.stars);
    const celestialBodies = this.celestialBodiesAt(displayTime);
    const geostationaryOrbitVisible = this.orbitGuideSettings.geostationary;
    this.syncReferenceLines(
      displayTime, floatingOrigin, visibilityPolicy,
      cameraSystem.activeCamera, cameraSystem.activeCameraPos);
    // 地球の静止軌道リングなど、天体固有のマップ付随表示。出すかどうかの判断はここが持つ。
    for (const body of this.entities) {
      body.syncMapOverlay(
        floatingOrigin, displayTime, cameraSystem, markerManager, celestialBodies,
        cameraSystem.overviewMode && geostationaryOrbitVisible);
    }
    this.orbitGuideLines.sync(style, displayTime, cameraSystem.overviewMode, floatingOrigin, cameraSystem.activeCamera);
    this.zeroVelocityLines.sync(displayTime, cameraSystem.overviewMode, floatingOrigin, cameraSystem.activeCamera);
    this.celestialGrid.sync(
      style, gridVisibility, cameraSystem.activeCamera,
      celestialShellScale(cameraSystem.overviewMode));
    this.scaleGrid.sync(floatingOrigin, displayTime, cameraSystem, this, gridVisibility);
  }

  // 天体照の光源の候補を組んで選定へ渡し、**選ばれたものだけ**を描画座標へ移してライティング
  // 側のスロットへ入れる。基準点は露出と同じ注視点。
  private syncPlanetLights(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem): void {
    const candidates = this.celestialBodiesAt(displayTime).map((celestialBody) => ({
      celestialBody,
      albedo: this.entityOf(celestialBody.id).lightSourceAlbedo ?? DEFAULT_ALBEDO,
    }));
    const lights = selectPlanetLights(
      candidates, this.starEntity?.radiantIntensity ?? null, cameraSystem.activeViewpoint.lookTarget);
    this.planetLight.set(lights.map((light) => ({
      center: fo.RtoThreeV3(light.celestialBody.state.r),
      radius: light.celestialBody.radius,
      radiance: light.radiance,
    })));
  }

  // 遮蔽パスへ、この1フレームの遮蔽器と環の帯を渡す。候補を組んで選定へ回し、**選ばれた
  // ものだけ**を描画座標へ移す。focusPos はマップの注視点で、艦など天体でない対象を注視して
  // いるなら null。
  private syncOcclusion(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, graphics: GraphicsSettingsData,
  ): void {
    const celestialBodies = this.celestialBodiesAt(displayTime);
    const focusId = focusTargetId(cameraSystem.mapCamera.focus);
    const focusPos = focusId === undefined
      ? null : celestialBodies.find((body) => body.id === focusId)?.state.r ?? null;
    this.sunOcclusion.setOccluders(
      selectOccluders(celestialBodies, fo.r, focusPos).map((body): Occluder => (
        { center: fo.RtoThreeV3(body.state.r), radius: body.radius }
      )));
    this.syncRingShadow(fo, displayTime, graphics);
  }

  // 環を持つ天体を候補として選定へ回し、選ばれた1体の帯を遮蔽パスへ渡す。選ばれなければ
  // 帯を空にする(影は落ちない)。
  private syncRingShadow(fo: FloatingOrigin, displayTime: number, graphics: GraphicsSettingsData): void {
    const candidates = this.entities.flatMap((body): RingShadowCandidate[] => {
      const rings = body.rings;
      if (rings === null) return [];
      return [{
        center: this.stateAt(body.id, displayTime).r,
        axis: body.motion.orientationAt(displayTime)?.axis ?? null,
        radius: body.def.radius,
        bands: rings.bands.map((band) => ({
          innerRadius: band.innerRadius,
          outerRadius: band.outerRadius,
          normalOpticalDepth: band.optics.normalOpticalDepth,
        })),
      }];
    });
    const ringed = selectRingShadow(candidates, fo.r, graphics);
    if (ringed === null) {
      this.sunOcclusion.setRings(ZERO_VECTOR, UP_VECTOR, []);
      return;
    }
    this.sunOcclusion.setRings(
      fo.RtoThreeV3(ringed.center),
      ringed.axis === null ? UP_VECTOR : this.toThreeNormal(ringed.axis),
      ringed.bands,
    );
  }

  // 大気パスへ、このフレームに大気を描く天体とそのサンプル点の数を渡す。
  private syncAtmosphere(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, graphics: GraphicsSettingsData,
  ): void {
    const scale = cameraSystem.activeCameraRadialScale;
    const candidates = this.entities.flatMap((body) => {
      const candidate = body.atmosphereCandidateAt(fo, displayTime, cameraSystem.activeCameraPos, scale);
      return candidate === null ? [] : [candidate];
    });
    this.atmosphere.setDraws(atmosphereDraws(candidates, graphics.atmosphere));
  }

  // 星球は描画原点(= カメラ)に固定した半径の殻。
  private syncStars(cameraSystem: CameraSystem, fixedBrightnessScale: number, visible: boolean): void {
    this.stars.mesh.position.set(0, 0, 0);
    this.stars.mesh.scale.setScalar(celestialShellScale(cameraSystem.overviewMode));
    this.stars.mesh.visible = visible;
    this.stars.setFixedBrightnessScale(fixedBrightnessScale);
  }

  private toThreeNormal(normal: Vec3): THREE.Vector3 {
    return new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  }

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。実体も濃さも個体が
  // 持ち、ここは表示ポリシーから「出すか」だけを決めて個体へ指示する。
  // cameraPos は個体がフェードを測る基準(カメラの真の ECI 位置)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, visibilityPolicy: MapVisibilityPolicy | null,
    camera: THREE.Camera, cameraPos: Vec3,
  ): void {
    if (visibilityPolicy === null) {
      for (const body of this.entities) body.removeReferenceLine();
      return;
    }
    for (const body of this.entities) {
      // 恒星は公転しないので線を持たない。非表示の間は実体ごと解放し、頂点バッファを残さない。
      if (body.motion.kind === 'star' || !visibilityPolicy.body(body.id).orbit) {
        body.removeReferenceLine();
        continue;
      }
      body.syncReferenceLine(this.scene, simTime, fo, camera, cameraPos);
    }
  }

  // 点群はマップを一度も開かないプレイでは不要。最初のマップ更新時にだけシーンへ登録する。
  private buildPointField(pointField: PointFieldView): void {
    if (this.pointFieldBuilt) return;
    this.pointFieldBuilt = true;
    pointField.build(this.scene);
  }

  // 天体ビュー・星殻・グリッド・点群・参照線・照明を残さず解放する。
  dispose(): void {
    this.orbitGuideLines.dispose();
    this.zeroVelocityLines.dispose();
    // ライティングモデルを組ませるためだけの光源。
    this.lightingAnchor.removeFromParent();
    this.lightingAnchor.dispose();
    // 星殻・天球グリッド・縮尺グリッド。
    this.stars.mesh.removeFromParent();
    this.stars.dispose();
    this.celestialGrid.dispose();
    this.scaleGrid.dispose();
    // 各天体ビュー(参照軌道線を含む)と、マップを一度でも開いていれば生成済みの小天体点群。
    for (const body of this.entities) {
      body.removeReferenceLine();
      body.dispose();
    }
    if (this.pointFieldBuilt) this.pointFieldView?.dispose();
  }
}
