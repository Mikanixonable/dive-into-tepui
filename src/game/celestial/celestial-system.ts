// 天体系(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { CelestialBodyDef, CelestialMotion, PhaseOffsets } from '../../physics/celestial-motion';
import { CelestialBodyWindows } from '../../physics/celestial-body-windows';
import { ReferenceFrames } from '../../physics/reference-frames';
import { RingSystemDef } from '../../physics/celestial-body-def';
import { AU } from '../../physics/planet-orbit';
import { CelestialBody } from '../../physics/celestial-body';
import { len, norm, sub, v3, Vec3 } from '../../math/vec3';
import { maxOccludedFraction } from '../../physics/shadow';
import type { MarkerManager } from '../marker/marker-manager';
import { OrbitLine } from '../lines/orbit-line';
import { createStars, Stars, STAR_SHELL_RADIUS } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility } from '../../render/celestial-grid';
import { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import { FloatingOrigin } from '../camera/floating-origin';
import * as C from '../const';
import { PointFieldView } from './point-field-view';
import { ScaleGridView } from './scale-grid-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';
import { SUN_COLOR, SUN_RADIANT_INTENSITY, SunLight } from '../../render/pipeline/sun-light';
import type { Exposure } from '../../render/pipeline/exposure';
import type { PlanetLightSource } from '../../render/pipeline/lighting/planet-light-source';
import { AMBIENT_STRONG, AMBIENT_WEAK, type AmbientSource } from '../../render/pipeline/lighting/ambient-source';
import { selectPlanetLights } from './planet-light';
import { MAX_OCCLUDERS, type Occluder, type SunOcclusion } from '../../render/pipeline/sun-occlusion';
import type { AtmospherePass } from '../../render/pipeline/atmosphere-pass';
import { type AtmosphereCandidate, atmosphereDraws } from '../../render/atmosphere';
import { LIT_OPAQUE_LAYER } from '../../render/pipeline/lit-layer';
import { CelestialEntity } from './celestial-entity';
import { BodyClassToggles, NearbySystemTracker } from './body-visibility';
import { MapVisibilityPolicy } from './map-visibility';
import { OrbitGuideLines } from './orbit-guide-lines';
import { ZeroVelocityLines } from './zero-velocity-lines';
import { DEFAULT_ORBIT_GUIDE_SETTINGS, OrbitGuideSettings } from './orbit-guide-settings';

// 惑星・衛星の参照軌道線のフェード距離 [m]。カメラから天体までの距離がこれ未満なら非表示、
// FAR 以上なら完全表示、その間は距離に応じて線形にフェードインする。
const PLANET_ORBIT_LINE_FADE_NEAR_DIST = 1e9; // 100万km
const PLANET_ORBIT_LINE_FADE_FAR_DIST = 1e10; // 1000万km
const SATELLITE_ORBIT_LINE_FADE_NEAR_DIST = 5e8; // 50万km
const SATELLITE_ORBIT_LINE_FADE_FAR_DIST = 1e9; // 100万km

// 参照軌道線が完全表示のときの不透明度。
const REFERENCE_LINE_OPACITY = 0.3;

// 遮蔽器と環の持ち主を選ぶ尺度。カメラから見た視半径が大きい天体ほど、その影が画面に
// 写っている何かへ落ちる見込みが高い。
function apparentRadius(radius: number, center: Vec3, cameraPos: Vec3): number {
  return radius / Math.max(1, len(sub(center, cameraPos)));
}

// カメラから天体までの距離 dist に応じた参照軌道線の不透明度。惑星と衛星でフェード距離が異なる。
function referenceLineOpacityAt(body: CelestialEntity, dist: number): number {
  const isSatellite = body.motion.kind === 'satellite';
  const nearDist = isSatellite ? SATELLITE_ORBIT_LINE_FADE_NEAR_DIST : PLANET_ORBIT_LINE_FADE_NEAR_DIST;
  const farDist = isSatellite ? SATELLITE_ORBIT_LINE_FADE_FAR_DIST : PLANET_ORBIT_LINE_FADE_FAR_DIST;
  const t = Math.min(1, Math.max(0, (dist - nearDist) / (farDist - nearDist)));
  return t * REFERENCE_LINE_OPACITY;
}

// 遮蔽器として残す最大遮蔽率の下限。これを下回る天体は、どの向きでも恒星面の 1% 未満しか
// 隠せないので、落としても絵に出ない(physics/shadow.ts の maxOccludedFraction)。
const MIN_OCCLUDED_FRACTION = 1e-2;

// body が cameraPos か focusPos のどちらかから見て、絵に出るだけの影を落としうるか。
// **カメラ位置だけで測ってはいけない** — 土星から引いたマップビューでは土星自身が閾値を
// 切り、環の影が本体から消える。
function castsVisibleShadow(
  star: CelestialBody, body: CelestialBody, cameraPos: Vec3, focusPos: Vec3 | null,
): boolean {
  if (maxOccludedFraction(cameraPos, star, body) >= MIN_OCCLUDED_FRACTION) return true;
  return focusPos !== null && maxOccludedFraction(focusPos, star, body) >= MIN_OCCLUDED_FRACTION;
}

const ZERO_VECTOR = new THREE.Vector3();
const UP_VECTOR = new THREE.Vector3(0, 1, 0);

// 一様な環境光の割合。マップビューでは読みやすさのため強く、戦闘ビューでは弱く、どちらも
// 描画設定で切れる。
function ambientFraction(overviewMode: boolean, graphics: GraphicsSettingsData): number {
  if (overviewMode) return graphics.overviewAmbient ? AMBIENT_STRONG : 0;
  return graphics.combatAmbient ? AMBIENT_WEAK : 0;
}

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
  private readonly bodiesById: ReadonlyMap<string, CelestialEntity>;
  // 全天体の運動(bodies と同じ宣言順)。THREE 非依存の層(body-visibility 等)へ列挙を
  // 渡すときはこれを使う。
  readonly motions: readonly CelestialMotion[];
  // 主星の個体。恒星を持たない星系では null。
  private readonly starBody: CelestialEntity | null;
  private readonly nearbyTracker = new NearbySystemTracker();
  // 座標系の同一性と、同一時刻の天体窓。どちらも bodies の motion から組む。
  private readonly referenceFrames: ReferenceFrames;
  private readonly bodyWindows: CelestialBodyWindows;
  // 小惑星帯・トロヤ群の点群。天体暦から作られるマップ専用の表示なので、マップへ入るまで
  // 生成しない。11,200点の軌道要素・mesh・instance bufferをロード時に確保しないため。
  private pointFieldView: PointFieldView | null = null;

  // ラグランジュ点まわりの周期・準周期軌道のガイド線(表示パネルの軌道ガイドタブ、静止軌道を除く)。
  private orbitGuideLines!: OrbitGuideLines;
  // ゼロ速度曲線(ガイドタブ5.3節)。
  private zeroVelocityLines!: ZeroVelocityLines;
  // 軌道ガイドタブの正本の鏡映し。静止軌道リング・ラベルの表示可否だけをここから読む。
  private orbitGuideSettings: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;

  // bodies はこの星系の全天体(宣言順。重力源配列・一覧の順序もこれで決まる)、origin は
  // その中の ECI 中心天体。phaseOffsets は motion を組むのに使った初期位相(セーブでそのまま
  // 返すために保持する)。THREE の資源はここでは受け取らない — build(scene, …) が登録する。
  constructor(
    readonly bodies: readonly CelestialEntity[],
    readonly origin: CelestialEntity,
    private readonly phaseOffsets: PhaseOffsets,
  ) {
    this.motions = bodies.map((b) => b.motion);
    this.referenceFrames = new ReferenceFrames(this.motions, origin.motion);
    this.bodyWindows = new CelestialBodyWindows(this.motions);
    this.bodiesById = new Map(bodies.map((b) => [b.id, b]));
    this.starBody = bodies.find((b) => b.motion.kind === 'star') ?? null;
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
    for (const body of this.bodies) body.build(scene, sunOcclusion, sunLight);
  }

  // ---------------------------------------------------------------- 天体の口

  // 天体 id の個体。未登録の id を渡すと例外になる。
  bodyOf(id: string): CelestialEntity {
    const body = this.bodiesById.get(id);
    if (body === undefined) throw new Error(`CelestialSystem: 登録されていない天体 id: ${id}`);
    return body;
  }

  find(id: string): CelestialEntity | null { return this.bodiesById.get(id) ?? null; }

  has(id: string): boolean { return this.bodiesById.has(id); }

  // 天体 id の表示名。未登録の id はそのまま返す(架空天体のラベルを例外で止めない)。
  nameOf(id: string): string { return this.bodiesById.get(id)?.name ?? id; }

  // 主星の個体。恒星を持たない星系では null。
  get star(): CelestialEntity | null { return this.starBody; }

  // 全登録天体の定義(宣言順)。
  get defs(): readonly CelestialBodyDef[] { return this.bodies.map((b) => b.def); }

  // ---------------------------------------------------------- 系レベルの物理

  // 指定時刻の全登録天体(宣言順)。同一 t には同一の配列参照が返るので、**呼び出し側は
  // この配列と要素を書き換えてはならない**(gravityAttractorsAt / atmosphere… も同じ)。
  celestialBodiesAt(t: number): readonly CelestialBody[] { return this.windows.celestialBodiesAt(t); }

  // 指定時刻の重力源天体(mu が 0 でないもの、宣言順)。
  gravityAttractorsAt(t: number): readonly CelestialBody[] { return this.windows.gravityAttractorsAt(t); }

  // 1天体ぶんの時刻 t での重力源表現。予測弧の候補供給(FutureCelestialBodyProvider)もこれで満たす。
  celestialBodyAt(id: string, t: number): CelestialBody { return this.bodyOf(id).motion.at(t); }

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
    const star = this.starBody;
    return star === null ? v3(1, 0, 0) : norm(sub(star.motion.stateAt(t).r, r));
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
    const bodies = this.windows.celestialBodiesStats;
    const time = this.windows.stats;
    return {
      celestialBodiesCacheHits: bodies.hits, celestialBodiesCacheMisses: bodies.misses,
      timeCacheHits: time.hits, timeCacheMisses: time.misses,
    };
  }

  // 表示時刻 t の点群の位置を更新する。
  update(t: number, overviewMode: boolean, graphics: GraphicsSettingsData): void {
    const star = this.starBody;
    if (!overviewMode || star === null || !graphics.pointField) return;
    const pointField = this.ensurePointField();
    pointField.update(t, true, star.motion);
  }

  // 軌道ガイドタブ(表示パネル5.2節)の設定。ゲーム側が変更のたびに渡す。
  setOrbitGuideSettings(settings: OrbitGuideSettings): void {
    this.orbitGuideSettings = settings;
    this.orbitGuideLines.setSettings(settings);
    this.zeroVelocityLines.setSettings(settings.zeroVelocity);
  }

  // 公転天体1体につき1本の参照軌道線(右クリックの当たり判定向け)。線を持つ個体だけを列挙する。
  get referenceOrbitLines(): readonly { readonly id: string; readonly line: OrbitLine }[] {
    return this.bodies.flatMap((b) => (b.referenceLine === null ? [] : [{ id: b.id, line: b.referenceLine }]));
  }

  // ラグランジュ点まわりの軌道ガイド線(右クリックの当たり判定向け)。
  get orbitGuide(): OrbitGuideLines { return this.orbitGuideLines; }

  // ECI の極軸を自転軸とする天体(この座標系を定義している天体)の自転初期位相(セーブ用)。
  // その天体が星系に無ければ undefined。
  earthSpinPhase0(): number | undefined {
    const pole = this.bodies.find((b) => 'pole' in b.def && b.def.pole?.kind === 'eciPole');
    return pole?.motion.spinPhase0;
  }

  // 天体ビュー・星・照明・遮蔽・参照線・天球グリッドを、この1フレームの表示状態に同期する。
  sync(
    floatingOrigin: FloatingOrigin,
    displayTime: number,
    cameraSystem: CameraSystem,
    graphics: GraphicsSettingsData,
    style: RenderStyle,
    gridVisibility: CelestialGridVisibility,
    sharedVisibilityPolicy: MapVisibilityPolicy | null = null,
    markerManager: MarkerManager | null = null,
  ): void {
    // Game.sync が同じカメラ位置・表示時刻で組んだ policy を渡せるようにする。渡されない
    // 既存経路ではここで一度だけ構築し、参照線にも同じインスタンスを渡す。
    const nearbyIds = cameraSystem.overviewMode && sharedVisibilityPolicy === null
      ? this.nearbyTracker.membersAt(
        this.motions, cameraSystem.activeCameraPos, this.celestialBodiesAt(displayTime))
      : [];
    const visibilityPolicy = cameraSystem.overviewMode
      ? sharedVisibilityPolicy ?? new MapVisibilityPolicy(
        this,
        cameraSystem.bodyClassToggles,
        focusTargetId(cameraSystem.mapCamera.focus),
        nearbyIds,
      )
      : null;
    const star = this.starBody?.motion ?? null;
    for (const body of this.bodies) {
      body.setVisible(!cameraSystem.overviewMode || visibilityPolicy!.body(body.id).category);
      body.sync(floatingOrigin, displayTime, cameraSystem, star, graphics, style);
    }
    // 主星が無いレジストリでは、描画原点から見た恒星方向へ 1 天文単位の位置に半径 0 の光源を置く
    // (基準強度どおりの放射照度が届き、遮蔽パスは誰も遮らないと答える)。
    const sunPos = star === null
      ? this.toThreeNormal(this.sunDirFrom(floatingOrigin.r, displayTime)).multiplyScalar(AU)
      : floatingOrigin.RtoThreeV3(star.stateAt(displayTime).r);
    // 露出の順応と天体照の選定の基準点。カメラ位置ではなく注視点から取る —
    // マップビューではカメラが太陽系の外にいることがあり、そこを基準にすると露出が発散する。
    const reference = floatingOrigin.RtoThreeV3(cameraSystem.activeViewpoint.lookTarget);
    this.exposure.setReference(reference, sunPos);
    this.sunLight.set(sunPos, star === null ? 0 : star.def.radius, SUN_COLOR, SUN_RADIANT_INTENSITY);
    this.ambient.setFraction(ambientFraction(cameraSystem.overviewMode, graphics));
    this.syncPlanetLights(floatingOrigin, displayTime, cameraSystem);
    this.syncOcclusion(floatingOrigin, displayTime, cameraSystem, graphics);
    this.syncAtmosphere(floatingOrigin, displayTime, cameraSystem, graphics);

    const fixedBrightnessScale = this.exposure.fixedBrightnessScale;
    if (cameraSystem.overviewMode && star !== null && graphics.pointField) {
      this.ensurePointField().sync(
        floatingOrigin, true, cameraSystem.bodyClassToggles.smallBodyVisible, fixedBrightnessScale,
      );
    } else {
      this.pointFieldView?.sync(floatingOrigin, false, true, fixedBrightnessScale);
    }
    this.syncStars(cameraSystem, fixedBrightnessScale, gridVisibility.stars);
    const celestialBodies = this.celestialBodiesAt(displayTime);
    const geostationaryOrbitVisible = this.orbitGuideSettings.geostationary;
    this.syncReferenceLines(
      displayTime, floatingOrigin, cameraSystem.overviewMode,
      focusTargetId(cameraSystem.mapCamera.focus), cameraSystem.bodyClassToggles,
      visibilityPolicy, nearbyIds, cameraSystem.activeCamera, cameraSystem.activeCameraPos);
    // 地球の静止軌道リングなど、天体固有のマップ付随表示。出すかどうかの判断はここが持つ。
    for (const body of this.bodies) {
      body.syncMapOverlay(
        floatingOrigin, displayTime, cameraSystem, markerManager, celestialBodies,
        cameraSystem.overviewMode && geostationaryOrbitVisible);
    }
    this.orbitGuideLines.sync(style, displayTime, cameraSystem.overviewMode, floatingOrigin, cameraSystem.activeCamera);
    this.zeroVelocityLines.sync(displayTime, cameraSystem.overviewMode, floatingOrigin, cameraSystem.activeCamera);
    this.celestialGrid.sync(
      style, gridVisibility, cameraSystem.activeCamera,
      cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
    this.scaleGrid.sync(floatingOrigin, displayTime, cameraSystem, this, gridVisibility);
  }

  // 天体照の光源を選び、描画座標へ移してライティング側のスロットへ渡す。基準点は露出と
  // 同じ注視点。
  private syncPlanetLights(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem): void {
    const lights = selectPlanetLights(this, displayTime, cameraSystem.activeViewpoint.lookTarget);
    this.planetLight.set(lights.map((light) => ({
      center: fo.RtoThreeV3(light.body.state.r),
      radius: light.body.radius,
      radiance: light.radiance,
    })));
  }

  // 遮蔽パスへ、この1フレームの遮蔽器と環の帯を渡す。まず最大遮蔽率が閾値を切る天体を落とし、
  // 残りをカメラから見た視半径の大きい順に MAX_OCCLUDERS 体まで採る — 恒星の視半径が同じなら
  // 最大遮蔽率は視半径に比例するので、この並びは最大遮蔽率の降順と一致する。環は最上位の
  // 環付き天体 1 体ぶん。
  private syncOcclusion(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, graphics: GraphicsSettingsData,
  ): void {
    const bodies = this.celestialBodiesAt(displayTime);
    const star = bodies.find((body) => body.isStar);
    const focusId = focusTargetId(cameraSystem.mapCamera.focus);
    const focusPos = focusId === undefined
      ? null : bodies.find((body) => body.id === focusId)?.state.r ?? null;
    const ranked = bodies
      .filter((body) => !body.isStar && body.radius > 0
        && (star === undefined || castsVisibleShadow(star, body, fo.r, focusPos)))
      .map((body) => ({ body, apparent: apparentRadius(body.radius, body.state.r, fo.r) }))
      .sort((a, b) => b.apparent - a.apparent)
      .slice(0, MAX_OCCLUDERS);
    this.sunOcclusion.setOccluders(ranked.map(({ body }): Occluder => (
      { center: fo.RtoThreeV3(body.state.r), radius: body.radius }
    )));
    this.syncRingShadow(fo, displayTime, graphics);
  }

  // 環の影を落とす天体を1体選び、その帯を遮蔽パスへ渡す。画面に環付き天体が複数写る状況は
  // 実質起きないので、最も大きく見える1体だけを扱う。
  private syncRingShadow(fo: FloatingOrigin, displayTime: number, graphics: GraphicsSettingsData): void {
    let ringed: { readonly body: CelestialEntity; readonly rings: RingSystemDef } | null = null;
    let bestApparent = 0;
    if (graphics.rings) {
      for (const body of this.bodies) {
        const def = body.def;
        if (!('rings' in def) || def.rings === undefined) continue;
        const apparent = apparentRadius(def.radius, body.motion.stateAt(displayTime).r, fo.r);
        if (apparent <= bestApparent) continue;
        bestApparent = apparent;
        ringed = { body, rings: def.rings };
      }
    }
    if (ringed === null) {
      this.sunOcclusion.setRings(ZERO_VECTOR, UP_VECTOR, []);
      return;
    }
    const pole = ringed.body.motion.orientationAt(displayTime);
    this.sunOcclusion.setRings(
      fo.RtoThreeV3(ringed.body.motion.stateAt(displayTime).r),
      pole === null ? UP_VECTOR : this.toThreeNormal(pole.axis),
      ringed.rings.bands.map((band) => ({
        innerRadius: band.innerRadius,
        outerRadius: band.outerRadius,
        normalOpticalDepth: band.optics.normalOpticalDepth,
      })),
    );
  }

  // 大気パスへ、このフレームに大気を描く天体とそのサンプル点の数を渡す。
  private syncAtmosphere(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, graphics: GraphicsSettingsData,
  ): void {
    this.atmosphere.setDraws(
      atmosphereDraws(this.atmosphereCandidates(fo, displayTime, cameraSystem), graphics.atmosphere),
    );
  }

  // 大気を持つ参照天体を、カメラからその中心までの距離と、その距離での画面尺度と一緒に集める。
  // **尺度は直線距離で引く** — 深度で引くと、視点の背後にある天体が目の前にあるのと同じ尺度に
  // なり、画面に写っていないのに予算を総取りする。
  private atmosphereCandidates(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem,
  ): readonly AtmosphereCandidate[] {
    const scale = cameraSystem.activeCameraRadialScale;
    const candidates: AtmosphereCandidate[] = [];
    for (const body of this.bodies) {
      const optics = body.atmosphereOptics;
      if (optics === null) continue;
      const surfaceRadius = body.def.radius;
      const center = body.motion.stateAt(displayTime).r;
      candidates.push({
        body: { center: fo.RtoThreeV3(center), surfaceRadius, optics },
        distance: len(sub(cameraSystem.activeCameraPos, center)),
        metersPerPixel: scale(center),
      });
    }
    return candidates;
  }

  // 星球は描画原点(= カメラ)に固定した半径の殻。広範囲視点では CELESTIAL_SHELL_RADIUS まで
  // 拡大する(far は dist に連動して毎フレーム変わるため、殻の拡大率はそこから独立させる)。
  private syncStars(cameraSystem: CameraSystem, fixedBrightnessScale: number, visible: boolean): void {
    this.stars.mesh.position.set(0, 0, 0);
    this.stars.mesh.scale.setScalar(cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
    this.stars.mesh.visible = visible;
    this.stars.setFixedBrightnessScale(fixedBrightnessScale);
  }

  private toThreeNormal(normal: Vec3): THREE.Vector3 {
    return new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  }

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。実体は個体が持ち、
  // ここは「出すか(表示ポリシー)・濃さ(カメラ距離のフェード)」を決めて個体へ指示する。
  // cameraPos はフェード距離を測る基準(カメラの真の ECI 位置)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, overviewMode: boolean,
    focusId: string | undefined,
    toggles: BodyClassToggles, sharedVisibilityPolicy: MapVisibilityPolicy | null,
    nearbyIds: readonly string[], camera: THREE.Camera, cameraPos: Vec3,
  ): void {
    if (!overviewMode) {
      for (const body of this.bodies) body.removeReferenceLine();
      return;
    }
    const visibilityPolicy = sharedVisibilityPolicy ?? new MapVisibilityPolicy(
      this,
      toggles,
      focusId,
      nearbyIds,
    );
    for (const body of this.bodies) {
      // 恒星は公転しないので線を持たない。非表示の間は実体ごと解放し、頂点バッファを残さない。
      if (body.motion.kind === 'star' || !visibilityPolicy.body(body.id).orbit) {
        body.removeReferenceLine();
        continue;
      }
      const dist = len(sub(body.motion.stateAt(simTime).r, cameraPos));
      body.syncReferenceLine(this.scene, simTime, fo, camera, referenceLineOpacityAt(body, dist));
    }
  }

  // 点群はマップを一度も開かないプレイでは不要。最初のマップ更新時にだけ生成・登録する。
  private ensurePointField(): PointFieldView {
    if (this.pointFieldView === null) {
      this.pointFieldView = new PointFieldView();
      this.pointFieldView.build(this.scene);
    }
    return this.pointFieldView;
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
    for (const body of this.bodies) {
      body.removeReferenceLine();
      body.dispose();
    }
    this.pointFieldView?.dispose();
  }
}
