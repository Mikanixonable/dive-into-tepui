// 環境(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { kinematicState } from '../../physics/kinematic-state';
import { CelestialRegistry, RingSystemDef, SolarSystemId, bodyDef, primaryOf } from '../../physics/solar-system';
import { OrbitalElements } from '../../physics/elements';
import { AU } from '../../physics/planet-orbit';
import { CelestialBody, CelestialBodyId, OrbitingId, orbitalElementsOf } from '../../physics/celestial-body';
import { add, len, scale, sub, v3, Vec3 } from '../../math/vec3';
import { isOccluded } from '../../physics/occlusion';
import { maxOccludedFraction } from '../../physics/shadow';
import type { MarkerManager } from '../marker/marker-manager';
import { OrbitLine } from '../orbit-line';
import { createStars, Stars, STAR_SHELL_RADIUS } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility } from '../../render/celestial-grid';
import { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import { FloatingOrigin } from '../floating-origin';
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
import {
  type AtmosphereCandidate, atmosphereDraws, atmosphereOpticsOf,
} from '../../render/atmosphere';
import { LIT_OPAQUE_LAYER } from '../../render/pipeline/lit-layer';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import { CelestialView } from './celestial-view';
import { CELESTIAL_VIEWS, fallbackCelestialView } from './celestial-registry';
import { EarthView } from './earth-view';
import { BodyClassToggles, NearbySystemTracker } from './body-visibility';
import { MapVisibilityPolicy } from './map-visibility';
import { OrbitGuideLines } from './orbit-guide-lines';
import { ZeroVelocityLines } from './zero-velocity-lines';
import { DEFAULT_ORBIT_GUIDE_SETTINGS, OrbitGuideSettings } from './orbit-guide-settings';

// 静止軌道高度の参照リング。実在の衛星や特定経度を表すものではない定数。地球が現在の
// レジストリに実在しないなら架空レジストリでは無意味なので組まない(constructor で判定)。
function buildGeoElements(registry: CelestialRegistry): OrbitalElements | null {
  if (!('earth' in registry)) return null;
  const earth = bodyDef(registry, 'earth');
  const earthCelestialBody: CelestialBody = {
    id: 'earth', mu: earth.mu, radius: earth.radius,
    state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), accel: v3(), degree2: null, atmosphere: null,
    isStar: false,
  };
  return {
    a: earth.radius + 35786e3, e: 1e-6, p: earth.radius + 35786e3, incDeg: 0, period: 86164,
    hHat: v3(0, 1, 0), pHat: v3(1, 0, 0), qHat: v3(0, 0, -1), center: earthCelestialBody,
  };
}

// 公転天体の参照軌道線の色: 衛星は月軌道線の色、惑星は木星軌道線の色を踏襲し、
// 同じ種別の天体はすべて同じ色で引く。
const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;

// 遮蔽器と環の持ち主を選ぶ尺度。カメラから見た視半径が大きい天体ほど、その影が画面に
// 写っている何かへ落ちる見込みが高い。
function apparentRadius(radius: number, center: Vec3, cameraPos: Vec3): number {
  return radius / Math.max(1, len(sub(center, cameraPos)));
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

// 恒星以外の全公転天体の id(registry の宣言順)。天体が増えれば参照線もここから自動で増える。
function referenceLineIds(registry: CelestialRegistry): readonly OrbitingId[] {
  return Object.keys(registry).filter((id) => bodyDef(registry, id).kind !== 'star');
}

// 一様な環境光の割合。マップビューでは読みやすさのため強く、戦闘ビューでは弱く、どちらも
// 描画設定で切れる。
function ambientFraction(overviewMode: boolean, graphics: GraphicsSettingsData): number {
  if (overviewMode) return graphics.overviewAmbient ? AMBIENT_STRONG : 0;
  return graphics.combatAmbient ? AMBIENT_WEAK : 0;
}

export class EnvironmentScene {
  private readonly scene: THREE.Scene;
  // **絵に出ない光源。** three はカメラのチャンネルと重なる光源が 1 つも無いとライティング
  // モデルごと組まないので(NodeMaterial.setupLighting)、受け手を真っ黒にしないために
  // 1 個だけ置いてある。マテリアルパスは direct() を無効化し indirect() を照度バッファの
  // 読み出しへ差し替えるため、この光源の色も強度もどこからも読まれない — 光の値の正本は
  // SunLight ただ 1 つ。
  private readonly lightingAnchor: THREE.AmbientLight;
  private readonly stars: Stars;
  readonly celestialGrid: CelestialGrid;
  private readonly scaleGrid: ScaleGridView;
  private readonly bodies: readonly CelestialView[];
  private readonly nearbyTracker = new NearbySystemTracker();
  // 小惑星帯・トロヤ群の点群。天体暦から作られるマップ専用の表示なので、マップへ入るまで
  // 生成しない。11,200点の軌道要素・mesh・instance bufferをロード時に確保しないため。
  private pointFieldView: PointFieldView | null = null;

  // 静止軌道高度の参照リングは実在の天体ではないので、以下の天体駆動の配列とは別に持つ。
  // 地球が現在のレジストリに無ければ null(sync は非表示のまま何もしない)。
  readonly geoLine = new OrbitLine({ color: 0x8b93a0, opacity: 0.2, renderOrder: LINE_RENDER_ORDER.reference });
  private readonly geoElements: OrbitalElements | null;
  // 公転天体1体につき1本、registry から自動生成する参照軌道線(衛星は親惑星中心、
  // 惑星は太陽中心)。マップモード専用で、天体暦の状態から作られる表示なのでここが所有する。
  private readonly referenceIds: readonly OrbitingId[];
  private readonly referenceLines: Map<OrbitingId, OrbitLine>;
  // ラグランジュ点まわりの周期・準周期軌道のガイド線(表示パネルの軌道ガイドタブ、静止軌道を除く)。
  private readonly orbitGuideLines: OrbitGuideLines;
  // ゼロ速度曲線(ガイドタブ5.3節)。
  private readonly zeroVelocityLines: ZeroVelocityLines;
  // 軌道ガイドタブの正本の鏡映し。静止軌道リング・ラベルの表示可否だけをここから読む。
  private orbitGuideSettings: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;

  // 天体ビューの配列がすべて ephemeris から引く。天体暦はゲーム側が所有する単一インスタンスを
  // 共有参照する(状態を持たない純サンプラ)。sunLight はライティングパス(render/pipeline/)が
  // 読む恒星光の値オブジェクトで、RenderPipeline が所有するインスタンスをここへ書き込む。
  // earthSpinPhase0 は地球の自転初期位相(地球が現在のレジストリに無ければ何もしない)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
    private readonly sunLight: SunLight,
    private readonly exposure: Exposure,
    private readonly sunOcclusion: SunOcclusion,
    private readonly planetLight: PlanetLightSource,
    private readonly ambient: AmbientSource,
    private readonly atmosphere: AtmospherePass,
    earthSpinPhase0: number,
  ) {
    this.scene = scene;
    const registry = ephemeris.registry;
    scene.add(this.geoLine.line);
    this.geoElements = buildGeoElements(registry);
    this.referenceIds = referenceLineIds(registry);

    // 参照線はマップで表示される天体だけが必要とする。全カタログぶんを起動時に
    // GPUへ確保すると、非表示設定でも頂点バッファとオブジェクトが残り続ける。
    this.referenceLines = new Map();
    this.orbitGuideLines = new OrbitGuideLines(scene, ephemeris);
    this.zeroVelocityLines = new ZeroVelocityLines(scene, ephemeris);
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

    this.bodies = Object.keys(registry).map((id) =>
      id in CELESTIAL_VIEWS
        ? CELESTIAL_VIEWS[id as SolarSystemId].create(sunOcclusion, sunLight)
        : fallbackCelestialView(registry, id, sunOcclusion, sunLight));
    for (const body of this.bodies) body.build(scene);

    this.bodies.find((b): b is EarthView => b instanceof EarthView)?.setSpinPhase0(earthSpinPhase0);
  }

  // 表示時刻 t の点群の位置を更新する。
  update(t: number, overviewMode: boolean, graphics: GraphicsSettingsData): void {
    if (!overviewMode || this.ephemeris.starId === null || !graphics.pointField) return;
    const pointField = this.ensurePointField();
    pointField.update(t, true, this.ephemeris);
  }

  // 軌道ガイドタブ(表示パネル5.2節)の設定。ゲーム側が変更のたびに渡す。
  setOrbitGuideSettings(settings: OrbitGuideSettings): void {
    this.orbitGuideSettings = settings;
    this.orbitGuideLines.setSettings(settings);
    this.zeroVelocityLines.setSettings(settings.zeroVelocity);
  }

  // 公転天体1体につき1本の参照軌道線(右クリックの当たり判定向け)。
  get referenceOrbitLines(): ReadonlyMap<OrbitingId, OrbitLine> { return this.referenceLines; }

  // ラグランジュ点まわりの軌道ガイド線(右クリックの当たり判定向け)。
  get orbitGuide(): OrbitGuideLines { return this.orbitGuideLines; }

  // 地球の自転初期位相(セーブ用)。地球が現在のレジストリに無ければ undefined。
  earthSpinPhase0(): number | undefined {
    const earth = this.bodies.find((b): b is EarthView => b instanceof EarthView);
    return earth?.spinPhase0();
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
      ? this.nearbyTracker.membersAt(this.ephemeris.registry, cameraSystem.activeCameraPos, this.ephemeris.celestialBodiesAt(displayTime))
      : [];
    const visibilityPolicy = cameraSystem.overviewMode
      ? sharedVisibilityPolicy ?? new MapVisibilityPolicy(
        this.ephemeris.registry,
        cameraSystem.bodyClassToggles,
        focusTargetId(cameraSystem.mapCamera.focus),
        nearbyIds,
      )
      : null;
    for (const body of this.bodies) {
      body.setVisible(!cameraSystem.overviewMode || visibilityPolicy!.body(body.id).category);
      body.sync(floatingOrigin, displayTime, cameraSystem, this.ephemeris, graphics, style);
    }
    // 主星が無いレジストリでは、描画原点から見た恒星方向へ 1 天文単位の位置に半径 0 の光源を置く
    // (基準強度どおりの放射照度が届き、遮蔽パスは誰も遮らないと答える)。
    const starId = this.ephemeris.starId;
    const star = starId === null ? null : bodyDef(this.ephemeris.registry, starId);
    const sunPos = starId === null
      ? this.toThreeNormal(this.ephemeris.sunDirFrom(floatingOrigin.r, displayTime)).multiplyScalar(AU)
      : floatingOrigin.RtoThreeV3(this.ephemeris.positionOf(starId, displayTime));
    // 露出の順応と天体照の選定の基準点。カメラ位置ではなく注視点から取る —
    // マップビューではカメラが太陽系の外にいることがあり、そこを基準にすると露出が発散する。
    const reference = floatingOrigin.RtoThreeV3(cameraSystem.activeViewpoint.lookTarget);
    this.exposure.setReference(reference, sunPos);
    this.sunLight.set(sunPos, star?.radius ?? 0, SUN_COLOR, SUN_RADIANT_INTENSITY);
    this.ambient.setFraction(ambientFraction(cameraSystem.overviewMode, graphics));
    this.syncPlanetLights(floatingOrigin, displayTime, cameraSystem);
    this.syncOcclusion(floatingOrigin, displayTime, cameraSystem, graphics);
    this.syncAtmosphere(floatingOrigin, displayTime, cameraSystem, graphics);

    const fixedBrightnessScale = this.exposure.fixedBrightnessScale;
    if (cameraSystem.overviewMode && this.ephemeris.starId !== null && graphics.pointField) {
      this.ensurePointField().sync(
        floatingOrigin, true, cameraSystem.bodyClassToggles.smallBodyVisible, fixedBrightnessScale,
      );
    } else {
      this.pointFieldView?.sync(floatingOrigin, false, true, fixedBrightnessScale);
    }
    this.syncStars(cameraSystem, fixedBrightnessScale, gridVisibility.stars);
    const celestialBodies = this.ephemeris.celestialBodiesAt(displayTime);
    const geostationaryOrbitVisible = this.orbitGuideSettings.geostationary;
    this.syncReferenceLines(
      displayTime, floatingOrigin, cameraSystem.overviewMode,
      geostationaryOrbitVisible,
      focusTargetId(cameraSystem.mapCamera.focus), cameraSystem.bodyClassToggles,
      visibilityPolicy, nearbyIds, cameraSystem.activeCamera, cameraSystem.activeCameraPos);
    this.syncGeoLabels(
      displayTime, cameraSystem.overviewMode, geostationaryOrbitVisible,
      cameraSystem, markerManager, celestialBodies);
    this.orbitGuideLines.sync(style, displayTime, cameraSystem.overviewMode, floatingOrigin, cameraSystem.activeCamera);
    this.zeroVelocityLines.sync(displayTime, cameraSystem.overviewMode, floatingOrigin, cameraSystem.activeCamera);
    this.celestialGrid.sync(
      style, gridVisibility, cameraSystem.activeCamera,
      cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
    this.scaleGrid.sync(floatingOrigin, displayTime, cameraSystem, this.ephemeris, gridVisibility);
  }

  // 天体照の光源を選び、描画座標へ移してライティング側のスロットへ渡す。基準点は露出と
  // 同じ注視点。
  private syncPlanetLights(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem): void {
    const lights = selectPlanetLights(this.ephemeris, displayTime, cameraSystem.activeViewpoint.lookTarget);
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
    const bodies = this.ephemeris.celestialBodiesAt(displayTime);
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
    let ringed: { readonly id: OrbitingId; readonly rings: RingSystemDef } | null = null;
    let bestApparent = 0;
    if (graphics.rings) {
      for (const id of this.referenceIds) {
        const def = bodyDef(this.ephemeris.registry, id);
        if (def.kind !== 'planet' || def.rings === undefined) continue;
        const apparent = apparentRadius(def.radius, this.ephemeris.positionOf(id, displayTime), fo.r);
        if (apparent <= bestApparent) continue;
        bestApparent = apparent;
        ringed = { id, rings: def.rings };
      }
    }
    if (ringed === null) {
      this.sunOcclusion.setRings(ZERO_VECTOR, UP_VECTOR, []);
      return;
    }
    const pole = this.ephemeris.poleAt(ringed.id, displayTime);
    this.sunOcclusion.setRings(
      fo.RtoThreeV3(this.ephemeris.positionOf(ringed.id, displayTime)),
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
    for (const id of this.referenceIds) {
      const optics = atmosphereOpticsOf(id);
      if (optics === null) continue;
      const surfaceRadius = bodyDef(this.ephemeris.registry, id).radius;
      const center = this.ephemeris.positionOf(id, displayTime);
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

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。cameraPos はフェード
  // 距離を測る基準(カメラの真の ECI 位置)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, overviewMode: boolean, geostationaryOrbitVisible: boolean,
    focusId: CelestialBodyId | undefined,
    toggles: BodyClassToggles, sharedVisibilityPolicy: MapVisibilityPolicy | null,
    nearbyIds: readonly CelestialBodyId[], camera: THREE.Camera, cameraPos: Vec3,
  ): void {
    if (!overviewMode) {
      this.geoLine.sync(null, fo, camera);
      for (const [id] of this.referenceLines) this.removeReferenceLine(id);
      return;
    }
    const visibilityPolicy = sharedVisibilityPolicy ?? new MapVisibilityPolicy(
      this.ephemeris.registry,
      toggles,
      focusId,
      nearbyIds,
    );
    this.geoLine.sync(
      geostationaryOrbitVisible ? this.geoElements : null,
      fo, camera);
    if (geostationaryOrbitVisible && 'earth' in this.ephemeris.registry) {
      const earthPos = this.ephemeris.positionOf('earth', simTime);
      const distToEarth = len(sub(earthPos, cameraPos));
      // 静止軌道リングは 240,000km で薄れ始め 720,000km で消える。
      const geoFade = 1.0 - Math.min(1, Math.max(0, (distToEarth - 2.4e8) / 4.8e8));
      this.geoLine.setOpacity(0.55 * geoFade);
    }
    for (const id of this.referenceIds) {
      if (!visibilityPolicy.body(id).orbit) {
        this.removeReferenceLine(id);
        continue;
      }
      const line = this.ensureReferenceLine(id);
      const el = this.orbitElementsFor(id, simTime);
      line.sync(el, fo, camera);
      const dist = len(sub(this.ephemeris.stateOf(id, simTime).r, cameraPos));
      line.setOpacity(this.referenceLineOpacityAt(id, dist));
    }
  }

  // 静止軌道に沿った半透明の小さなテキスト文字ラベルを描画する。
  private syncGeoLabels(
    displayTime: number,
    overviewMode: boolean,
    geostationaryOrbitVisible: boolean,
    cameraSystem: CameraSystem,
    markerManager: MarkerManager | null,
    celestialBodies: readonly CelestialBody[],
  ): void {
    const keys = ['geolabel-0', 'geolabel-1', 'geolabel-2', 'geolabel-3'];
    if (!markerManager || !overviewMode || !geostationaryOrbitVisible || !this.geoElements || !('earth' in this.ephemeris.registry)) {
      if (markerManager) {
        for (const key of keys) markerManager.hide(key);
      }
      return;
    }

    const earthPos = this.ephemeris.positionOf('earth', displayTime);
    const cameraPos = cameraSystem.activeCameraPos;
    const distToEarth = len(sub(earthPos, cameraPos));
    // フェードアウト距離をさらに2倍(240,000km〜720,000km)にし、視認性を維持(0.90 * geoFade)
    const geoFade = 1.0 - Math.min(1, Math.max(0, (distToEarth - 2.4e8) / 4.8e8));
    const labelOpacity = 0.90 * geoFade;

    if (labelOpacity <= 0.02) {
      for (const key of keys) markerManager.hide(key);
      return;
    }

    const project = cameraSystem.activeCameraProjection;
    const rGeo = this.geoElements.a;
    const pHat = this.geoElements.pHat;
    const qHat = this.geoElements.qHat;

    const numLabels = 1;
    for (let i = 1; i < 4; i++) markerManager.hide(keys[i]!);
    for (let i = 0; i < numLabels; i++) {
      const key = keys[i]!;
      const theta = Math.PI / 4;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const pos = add(earthPos, add(scale(pHat, rGeo * cosT), scale(qHat, rGeo * sinT)));

      const p0 = project(pos);
      if (!p0.front || isOccluded(cameraPos, pos, celestialBodies)) {
        markerManager.hide(key);
        continue;
      }

      markerManager.set(
        key,
        'mk-geolabel',
        'GEO (35,786km)',
        p0.x,
        p0.y,
        p0.front,
        '',
        labelOpacity,
        undefined,
        undefined,
        false,
        true,
        C.MARKER_PRIORITY.ORBITAL_NODE,
        len(sub(pos, cameraPos)),
      );
    }
  }

  // カメラから天体までの距離 dist に応じた参照軌道線の不透明度。惑星と衛星でフェード距離が
  // 異なる。
  private referenceLineOpacityAt(id: OrbitingId, dist: number): number {
    const isSatellite = bodyDef(this.ephemeris.registry, id).kind === 'satellite';
    const nearDist = isSatellite ? C.SATELLITE_ORBIT_LINE_FADE_NEAR_DIST : C.PLANET_ORBIT_LINE_FADE_NEAR_DIST;
    const farDist = isSatellite ? C.SATELLITE_ORBIT_LINE_FADE_FAR_DIST : C.PLANET_ORBIT_LINE_FADE_FAR_DIST;
    const t = Math.min(1, Math.max(0, (dist - nearDist) / (farDist - nearDist)));
    return t * C.REFERENCE_LINE_OPACITY;
  }

  // 点群はマップを一度も開かないプレイでは不要。最初のマップ更新時にだけ生成・登録する。
  private ensurePointField(): PointFieldView {
    if (this.pointFieldView === null) {
      this.pointFieldView = new PointFieldView();
      this.pointFieldView.build(this.scene);
    }
    return this.pointFieldView;
  }

  private ensureReferenceLine(id: OrbitingId): OrbitLine {
    const existing = this.referenceLines.get(id);
    if (existing) return existing;
    const color = bodyDef(this.ephemeris.registry, id).kind === 'satellite'
      ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
    const line = new OrbitLine({ color, opacity: C.REFERENCE_LINE_OPACITY, renderOrder: LINE_RENDER_ORDER.reference });
    this.scene.add(line.line);
    this.referenceLines.set(id, line);
    return line;
  }

  private removeReferenceLine(id: OrbitingId): void {
    const line = this.referenceLines.get(id);
    if (!line) return;
    line.line.removeFromParent();
    line.dispose();
    this.referenceLines.delete(id);
  }

  // 公転天体の接触軌道要素(表示専用)。衛星は親惑星中心、惑星は主星中心 — 中心天体自身も
  // ECI 上を動くので、固定 CelestialBody ではなくその時刻の状態を毎回引いて組む。
  private orbitElementsFor(id: OrbitingId, simTime: number): OrbitalElements | null {
    const registry = this.ephemeris.registry;
    const centerId = primaryOf(registry, id);
    if (centerId === null) return null;
    const centerDef = bodyDef(registry, centerId);
    const center: CelestialBody = {
      id: centerId, mu: centerDef.mu, radius: centerDef.radius, state: this.ephemeris.stateOf(centerId, simTime),
      accel: v3(), degree2: null, atmosphere: null, isStar: centerDef.kind === 'star',
    };
    return orbitalElementsOf(this.ephemeris.stateOf(id, simTime), center);
  }

  // 天体ビュー・星殻・グリッド・点群・参照線・照明を残さず解放する。
  dispose(): void {
    // 静止軌道参照リングと公転天体ぶんの参照軌道線。
    this.geoLine.line.removeFromParent();
    this.geoLine.dispose();
    for (const id of [...this.referenceLines.keys()]) this.removeReferenceLine(id);
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
    // 各天体ビューと、マップを一度でも開いていれば生成済みの小天体点群。
    for (const body of this.bodies) body.dispose();
    this.pointFieldView?.dispose();
  }
}
