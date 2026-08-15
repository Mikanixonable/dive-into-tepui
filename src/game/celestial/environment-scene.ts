// 環境(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { kinematicState } from '../../physics/kinematic-state';
import { CelestialRegistry, SolarSystemId, bodyDef, primaryOf } from '../../physics/solar-system';
import { OrbitalElements } from '../../physics/elements';
import { Attractor, AttractorId, OrbitingId, orbitalElementsOf } from '../../physics/attractor';
import { Vec3, v3, sub, len } from '../../physics/vec3';
import { OrbitLine } from '../orbit-line';
import { createStars, Stars, STAR_SHELL_RADIUS } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility } from '../../render/celestial-grid';
import { SpatialGrid } from '../../render/spatial-grid';
import { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { PointFieldView } from './point-field-view';
import type { GraphicsSettings } from '../../render/graphics-settings';
import { SunLight } from '../../render/pipeline/sun-light';
import { LIT_OPAQUE_LAYER } from '../../render/pipeline/lit-layer';
import { CelestialBody } from './celestial-body';
import { CELESTIAL_BODIES, fallbackCelestialView } from './celestial-registry';
import { EarthBody } from './earth-body';
import { BodyClassToggles, systemMembersAt } from './body-visibility';
import { MapVisibilityPolicy } from './map-visibility';

// 静止軌道高度の参照リング。実在の衛星や特定経度を表すものではない定数。地球が現在の
// レジストリに実在しないなら架空レジストリでは無意味なので組まない(constructor で判定)。
function buildGeoElements(registry: CelestialRegistry): OrbitalElements | null {
  if (!('earth' in registry)) return null;
  const earth = bodyDef(registry, 'earth');
  const earthAttractor: Attractor = {
    id: 'earth', mu: earth.mu, radius: earth.radius,
    state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), degree2: null, isStar: false,
  };
  return {
    a: earth.radius + 35786e3, e: 1e-6, p: earth.radius + 35786e3, incDeg: 0, period: 86164,
    hHat: v3(0, 1, 0), pHat: v3(1, 0, 0), qHat: v3(0, 0, -1), center: earthAttractor,
  };
}

// 公転天体の参照軌道線の色: 衛星は月軌道線の色、惑星は木星軌道線の色を踏襲し、
// 同じ種別の天体はすべて同じ色で引く。
const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;

// 恒星光の色。THREE.DirectionalLight と render/pipeline/sun-light.ts の SunLight の両方が
// この同じ値を受け取る — 世界パスとライティングパスで別々の色にならないようにするため。
const SUN_COLOR = new THREE.Color(0xfff4e0);

// 恒星以外の全公転天体の id(registry の宣言順)。天体が増えれば参照線もここから自動で増える。
function referenceLineIds(registry: CelestialRegistry): readonly OrbitingId[] {
  return Object.keys(registry).filter((id) => bodyDef(registry, id).kind !== 'star');
}

export class EnvironmentScene {
  private readonly scene: THREE.Scene;
  readonly ambient: THREE.AmbientLight;
  // 自機・デブリ・薬莢を直接照らすことはない(それらは LIT_OPAQUE_LAYER 単独に立ち、
  // 既定チャンネルの world パスには描かれない) — マテリアルパスが読む SunLight への
  // 生値の供給元と、LIT_OPAQUE_LAYER を絞ったカメラでも光源としてカメラに拾われ続ける
  // ための存在。天体は各自の CelestialSurface が sunDirection uniform を持って
  // 自分で陰影を計算するので、いずれにせよこの光を受けない。
  private readonly directionalLight: THREE.DirectionalLight;
  private readonly stars: Stars;
  readonly celestialGrid: CelestialGrid;
  readonly spatialGrid: SpatialGrid;
  private readonly bodies: readonly CelestialBody[];
  // 小惑星帯・トロヤ群の点群。天体暦から作られるマップ専用の表示なので、マップへ入るまで
  // 生成しない。11,200点の軌道要素・mesh・instance bufferをロード時に確保しないため。
  private pointFieldView: PointFieldView | null = null;

  // 静止軌道高度の参照リングは実在の天体ではないので、以下の天体駆動の配列とは別に持つ。
  // 地球が現在のレジストリに無ければ null(sync は非表示のまま何もしない)。
  readonly geoLine = new OrbitLine(0x8b93a0, 0.2, C.LINE_RENDER_ORDER.reference);
  private readonly geoElements: OrbitalElements | null;
  // 公転天体1体につき1本、registry から自動生成する参照軌道線(衛星は親惑星中心、
  // 惑星は太陽中心)。マップモード専用で、天体暦の状態から作られる表示なのでここが所有する。
  private readonly referenceIds: readonly OrbitingId[];
  private readonly referenceLines: Map<OrbitingId, OrbitLine>;

  // 天体ビューの配列がすべて ephemeris から引く。天体暦はゲーム側が所有する単一インスタンスを
  // 共有参照する(状態を持たない純サンプラ)。sunLight はライティングパス(render/pipeline/)が
  // 読む恒星光の値オブジェクトで、RenderPipeline が所有するインスタンスをここへ書き込む。
  // earthSpinPhase0 は地球の自転初期位相(地球が現在のレジストリに無ければ何もしない)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
    private readonly graphics: GraphicsSettings,
    private readonly sunLight: SunLight,
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
    this.ambient = new THREE.AmbientLight(0x8899bb, C.AMBIENT_INTENSITY);
    scene.add(this.ambient);
    this.directionalLight = new THREE.DirectionalLight(SUN_COLOR.getHex(), C.SUN_INTENSITY);
    scene.add(this.directionalLight);
    // レンダラーは光源自身の layers とカメラの layers が重ならないと光源をそのカメラの描画対象
    // から除外する(direct()/indirect() どちらかの呼び出し自体が起きなくなる)。マテリアルパスは
    // 自身の render() の間だけカメラを LIT_OPAQUE_LAYER 単独へ絞るため、この光源も同チャンネルへ
    // 加えておかないと、間接光評価そのものがスキップされてしまう。
    this.ambient.layers.enable(LIT_OPAQUE_LAYER);
    this.directionalLight.layers.enable(LIT_OPAQUE_LAYER);
    this.stars = createStars();
    scene.add(this.stars.mesh);
    this.celestialGrid = new CelestialGrid(scene);
    this.spatialGrid = new SpatialGrid(scene);

    this.bodies = Object.keys(registry).map((id) =>
      id in CELESTIAL_BODIES ? CELESTIAL_BODIES[id as SolarSystemId].create() : fallbackCelestialView(registry, id));
    for (const body of this.bodies) body.build(scene);

    this.bodies.find((b): b is EarthBody => b instanceof EarthBody)?.setSpinPhase0(earthSpinPhase0);
  }

  // 表示時刻 t の点群の位置を更新する。
  update(t: number, overviewMode: boolean): void {
    if (!overviewMode || this.ephemeris.starId === null || !this.graphics.current.pointField) return;
    const pointField = this.ensurePointField();
    pointField.update(t, true, this.ephemeris);
  }

  // 地球の自転初期位相(セーブ用)。地球が現在のレジストリに無ければ undefined。
  earthSpinPhase0(): number | undefined {
    const earth = this.bodies.find((b): b is EarthBody => b instanceof EarthBody);
    return earth?.spinPhase0();
  }

  // 天体ビュー・星・照明・参照線・天球グリッドを、この1フレームの表示状態に同期する。
  // playerPos は照明の日照率を引く基準位置。艦がいなければ null(このフレームは減光しない)。
  //
  // TODO: アクティブ艦1点の日照率を平行光・環境光の全体へ流用しているのは、「全エンティティが
  // その近くにいる」という成り立っていない前提に乗った近似。艦がいないフレームに、実在する他の
  // エンティティを照らせなくなるのはその帰結にすぎない。null を減光なしで埋めるのは暫定処置で、
  // 照度はエンティティごとに引くか、遮蔽そのものをシャドウマップへ置き換える。
  sync(
    playerPos: Vec3 | null,
    floatingOrigin: FloatingOrigin,
    displayTime: number,
    cameraSystem: CameraSystem,
    gridVisibility: CelestialGridVisibility,
    sharedVisibilityPolicy: MapVisibilityPolicy | null = null,
  ): void {
    // lit は自機位置の日照率。主星が無いレジストリでは日照そのものが無意味なので計算を飛ばす。
    let lit = 1.0;
    if (playerPos !== null && !cameraSystem.overviewMode && this.ephemeris.starId !== null) {
      const attractorsNow = this.ephemeris.attractorsAt(displayTime);
      const star = attractorsNow.find((a) => a.id === this.ephemeris.starId);
      if (star) lit = sunlitFactor(playerPos, star, attractorsNow);
    }
    // Game.sync が同じカメラ位置・表示時刻で組んだ policy を渡せるようにする。渡されない
    // 既存経路ではここで一度だけ構築し、参照線にも同じインスタンスを渡す。
    const nearbyIds = cameraSystem.overviewMode && sharedVisibilityPolicy === null
      ? systemMembersAt(this.ephemeris.registry, cameraSystem.activeCameraPos, this.ephemeris.attractorsAt(displayTime))
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
      body.sync(floatingOrigin, displayTime, cameraSystem, this.ephemeris, this.graphics);
    }
    // 平行光の向きは描画原点から見た恒星方向 — 照らす相手がその近傍にいる物体だけなので、
    // 全員が同じ向きでよい。
    const sd = this.ephemeris.sunDirFrom(floatingOrigin.r, displayTime);
    const sunDirWorld = new THREE.Vector3(sd.x, sd.y, sd.z);
    this.directionalLight.position.copy(sunDirWorld).multiplyScalar(1e5);
    this.directionalLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.ambient.intensity = C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);
    // ライティングパス向けの値。遮蔽の下限式は SunLight 自身が sunlitFactor から掛けるので、
    // ここで渡すのは掛ける前の生値。
    this.sunLight.set(sunDirWorld, SUN_COLOR, C.SUN_INTENSITY, C.AMBIENT_INTENSITY, lit);

    if (cameraSystem.overviewMode && this.ephemeris.starId !== null && this.graphics.current.pointField) {
      this.ensurePointField().sync(
        floatingOrigin, true, cameraSystem.bodyClassToggles.smallBodyVisible,
      );
    } else {
      this.pointFieldView?.sync(floatingOrigin, false, true);
    }
    this.syncStars(cameraSystem, gridVisibility.stars);
    this.syncReferenceLines(
      displayTime, floatingOrigin, cameraSystem.overviewMode,
      focusTargetId(cameraSystem.mapCamera.focus), cameraSystem.bodyClassToggles,
      visibilityPolicy, nearbyIds, cameraSystem.activeCamera, cameraSystem.activeCameraPos);
    this.celestialGrid.sync(
      gridVisibility, cameraSystem.activeCamera,
      cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
    this.spatialGrid.sync(
      cameraSystem.overviewMode,
      gridVisibility.eclipticScaleGrid,
      gridVisibility.equatorScaleGrid,
      gridVisibility.moonOrbitScaleGrid,
      'moon' in this.ephemeris.registry ? this.toThreeNormal(this.ephemeris.orbitNormalAt('moon', displayTime)) : undefined,
      cameraSystem.mapCamera.resolvedFocus,
      floatingOrigin,
      cameraSystem.activeCamera,
      cameraSystem.mapCamera.dist,
    );
  }

  // 星球はカメラに追従する固定半径の殻。広範囲視点では CELESTIAL_SHELL_RADIUS まで拡大する
  // (far は dist に連動して毎フレーム変わるため、殻の拡大率はそこから独立させる)。
  private syncStars(cameraSystem: CameraSystem, visible = true): void {
    this.stars.mesh.position.copy(cameraSystem.activeCamera.position);
    this.stars.mesh.scale.setScalar(cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
    this.stars.mesh.visible = visible;
  }

  private toThreeNormal(normal: Vec3): THREE.Vector3 {
    return new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  }

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。cameraPos はフェード
  // 距離を測る基準(カメラの真の ECI 位置)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, overviewMode: boolean, focusId: AttractorId | undefined,
    toggles: BodyClassToggles, sharedVisibilityPolicy: MapVisibilityPolicy | null,
    nearbyIds: readonly AttractorId[], camera: THREE.Camera, cameraPos: Vec3,
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
    this.geoLine.sync(this.geoElements, fo, camera, false);
    for (const id of this.referenceIds) {
      if (!visibilityPolicy.body(id).orbit) {
        this.removeReferenceLine(id);
        continue;
      }
      const line = this.ensureReferenceLine(id);
      const el = this.orbitElementsFor(id, simTime);
      line.sync(el, fo, camera, false);
      const dist = len(sub(this.ephemeris.stateOf(id, simTime).r, cameraPos));
      line.setOpacity(this.referenceLineOpacityAt(id, dist));
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
    const line = new OrbitLine(color, C.REFERENCE_LINE_OPACITY, C.LINE_RENDER_ORDER.reference);
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
  // ECI 上を動くので、固定 Attractor ではなくその時刻の状態を毎回引いて組む。
  private orbitElementsFor(id: OrbitingId, simTime: number): OrbitalElements | null {
    const registry = this.ephemeris.registry;
    const centerId = primaryOf(registry, id);
    if (centerId === null) return null;
    const centerDef = bodyDef(registry, centerId);
    const center: Attractor = {
      id: centerId, mu: centerDef.mu, radius: centerDef.radius, state: this.ephemeris.stateOf(centerId, simTime),
      degree2: null, isStar: centerDef.kind === 'star',
    };
    return orbitalElementsOf(this.ephemeris.stateOf(id, simTime), center);
  }

  // 天体ビュー・星殻・グリッド・点群・参照線・照明を残さず解放する。
  dispose(): void {
    // 静止軌道参照リングと公転天体ぶんの参照軌道線。
    this.geoLine.line.removeFromParent();
    this.geoLine.dispose();
    for (const id of [...this.referenceLines.keys()]) this.removeReferenceLine(id);
    // 環境光・平行光。
    this.ambient.removeFromParent();
    this.ambient.dispose();
    this.directionalLight.removeFromParent();
    this.directionalLight.dispose();
    // 星殻・天球グリッド・空間グリッド。
    this.stars.mesh.removeFromParent();
    this.stars.dispose();
    this.celestialGrid.dispose();
    this.spatialGrid.dispose();
    // 各天体ビューと、マップを一度でも開いていれば生成済みの小天体点群。
    for (const body of this.bodies) body.dispose();
    this.pointFieldView?.dispose();
  }
}
