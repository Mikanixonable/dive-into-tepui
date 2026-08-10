// 環境(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { kinematicState } from '../../physics/kinematic-state';
import { CelestialRegistry, SolarSystemId, bodyDef, primaryOf } from '../../physics/solar-system';
import { OrbitalElements, positionOnOrbit, trueAnomalyAt } from '../../physics/elements';
import { Attractor, AttractorId, OrbitingId, orbitalElementsOf } from '../../physics/attractor';
import { Vec3, v3, sub } from '../../physics/vec3';
import { OrbitLine } from '../../render/orbit-line';
import { createStars, STAR_SHELL_RADIUS } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility } from '../../render/celestial-grid';
import { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { PointFieldView } from './point-field-view';
import { CelestialBody } from './celestial-body';
import { CELESTIAL_BODIES, fallbackCelestialView } from './celestial-registry';
import { EarthBody } from './earth-body';
import { bodyClassOf } from './body-class';
import { BodyClassToggles, systemMembersAt } from './body-visibility';

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

// 恒星以外の全公転天体の id(registry の宣言順)。天体が増えれば参照線もここから自動で増える。
function referenceLineIds(registry: CelestialRegistry): readonly OrbitingId[] {
  return Object.keys(registry).filter((id) => bodyDef(registry, id).kind !== 'star');
}

// フォーカス中のラベル id が属する惑星系(その惑星の id)。惑星なら自身、衛星なら親惑星、
// ラグランジュ点ラベル(`<id>-l1` 等)ならその副天体で解決する。惑星系に属さない、または
// フォーカス中の天体が無い(focusId が undefined)なら null。
function focusSystemOf(registry: CelestialRegistry, focusId: AttractorId | undefined): AttractorId | null {
  if (focusId === undefined) return null;
  const bodyId = focusId.replace(/-l[1-5]$/, '');
  if (!(bodyId in registry)) return null;
  const def = bodyDef(registry, bodyId);
  if (def.kind === 'planet') return def.id;
  return def.kind === 'satellite' ? def.planet : null;
}

export class EnvironmentScene {
  private readonly scene: THREE.Scene;
  readonly ambient: THREE.AmbientLight;
  // 描画原点の近傍にある実スケールの物体(自機・デブリ・薬莢)を照らす平行光。天体は
  // 描画位置が真の位置と一致しないためこの光を受けず、自分で陰影を計算する。
  private readonly sunLight: THREE.DirectionalLight;
  readonly starsMesh: THREE.Mesh;
  readonly celestialGrid: CelestialGrid;
  private readonly bodies: readonly CelestialBody[];
  // 小惑星帯・トロヤ群の点群。天体暦から作られるマップ専用の表示なので、マップへ入るまで
  // 生成しない。11,200点の軌道要素・mesh・instance bufferをロード時に確保しないため。
  private pointFieldView: PointFieldView | null = null;

  // 静止軌道高度の参照リングは実在の天体ではないので、以下の天体駆動の配列とは別に持つ。
  // 地球が現在のレジストリに無ければ null(sync は非表示のまま何もしない)。
  readonly geoLine = new OrbitLine(0x8b93a0, 0.2);
  private readonly geoElements: OrbitalElements | null;
  // 公転天体1体につき1本、registry から自動生成する参照軌道線(衛星は親惑星中心、
  // 惑星は太陽中心)。マップモード専用で、天体暦の状態から作られる表示なのでここが所有する。
  private readonly referenceLines = new Map<OrbitingId, OrbitLine>();
  private referenceLinesBuilt = false;

  // 天体ビューの配列がすべて ephemeris から引く。天体暦はゲーム側が所有する単一インスタンスを
  // 共有参照する(状態を持たない純サンプラ)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
  ) {
    this.scene = scene;
    const registry = ephemeris.registry;
    this.geoLine.line.renderOrder = 0;
    scene.add(this.geoLine.line);
    this.geoElements = buildGeoElements(registry);

    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    scene.add(this.ambient);
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
    scene.add(this.sunLight);
    this.starsMesh = createStars();
    scene.add(this.starsMesh);
    this.celestialGrid = new CelestialGrid(scene);

    this.bodies = Object.keys(registry).map((id) =>
      id in CELESTIAL_BODIES ? CELESTIAL_BODIES[id as SolarSystemId].create() : fallbackCelestialView(registry, id));
    for (const body of this.bodies) body.build(scene);
  }

  // 表示時刻 t の点群の位置を更新する。
  update(t: number, overviewMode: boolean): void {
    if (!overviewMode || this.ephemeris.starId === null) return;
    const pointField = this.ensurePointField();
    pointField.update(t, true, this.ephemeris);
  }

  // 地球の自転初期位相(セーブ用)。地球が現在のレジストリに無ければ undefined。
  earthSpinPhase0(): number | undefined {
    const earth = this.bodies.find((b): b is EarthBody => b instanceof EarthBody);
    return earth?.spinPhase0();
  }

  // 地球の自転初期位相を差し替える(ロード用)。地球が現在のレジストリに無ければ何もしない。
  setEarthSpinPhase0(phase0: number): void {
    const earth = this.bodies.find((b): b is EarthBody => b instanceof EarthBody);
    earth?.setSpinPhase0(phase0);
  }

  // 天体ビュー・星・照明・参照線・天球グリッドを、この1フレームの表示状態に同期する。
  // playerPos は照明の日照率を引く基準位置。
  sync(
    playerPos: Vec3,
    floatingOrigin: FloatingOrigin,
    displayTime: number,
    cameraSystem: CameraSystem,
    gridVisibility: CelestialGridVisibility,
  ): void {
    // lit は自機位置の日照率(円柱影の近似)。物理的に正確ではない。主星が無いレジストリでは
    // 日照そのものが無意味なので計算を飛ばす。
    const lit = cameraSystem.overviewMode || this.ephemeris.starId === null
      ? 1.0
      : sunlitFactor(playerPos, this.ephemeris.sunDirFrom(playerPos, displayTime), C.SHADOW_PENUMBRA);
    for (const body of this.bodies) body.sync(floatingOrigin, displayTime, cameraSystem, this.ephemeris);
    // 平行光の向きは描画原点から見た恒星方向 — 照らす相手がその近傍にいる物体だけなので、
    // 全員が同じ向きでよい。
    const sd = this.ephemeris.sunDirFrom(floatingOrigin.r, displayTime);
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    this.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.ambient.intensity = C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);

    if (cameraSystem.overviewMode && this.ephemeris.starId !== null) {
      this.ensurePointField().sync(floatingOrigin, true);
    } else {
      this.pointFieldView?.sync(floatingOrigin, false);
    }
    this.syncStars(cameraSystem);
    this.syncReferenceLines(
      displayTime, floatingOrigin, cameraSystem.overviewMode,
      focusTargetId(cameraSystem.overviewCamera.focus), cameraSystem.bodyClassToggles,
      systemMembersAt(this.ephemeris.registry, cameraSystem.activeCameraPos, this.ephemeris.attractorsAt(displayTime)));
    this.celestialGrid.sync(
      gridVisibility, cameraSystem.activeCamera,
      cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
  }

  // 星球はカメラに追従する固定半径の殻。広範囲視点では CELESTIAL_SHELL_RADIUS まで拡大する
  // (far は dist に連動して毎フレーム変わるため、殻の拡大率はそこから独立させる)。
  private syncStars(cameraSystem: CameraSystem): void {
    this.starsMesh.position.copy(cameraSystem.activeCamera.position);
    this.starsMesh.scale.setScalar(cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
  }

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, overviewMode: boolean, focusId: AttractorId | undefined,
    toggles: BodyClassToggles, nearbyIds: readonly AttractorId[],
  ): void {
    if (!overviewMode) {
      this.geoLine.sync(null, fo);
      for (const line of this.referenceLines.values()) line.sync(null, fo);
      return;
    }
    this.ensureReferenceLines();
    this.geoLine.sync(this.geoElements, fo, false);
    for (const [id, line] of this.referenceLines) {
      const show = this.showsReferenceLine(id, focusId, toggles, nearbyIds);
      const el = show ? this.orbitElementsFor(id, simTime) : null;
      const rel = el ? sub(this.ephemeris.stateOf(id, simTime).r, el.center.state.r) : null;
      // 離心率の大きい軌道(彗星など)は近日点付近で曲率が急なので、そこへ頂点を寄せないと
      // 楕円が多角形として粗く見える。それ以外は天体自身の位置へ寄せる — 除去できる
      // セグメントの幅は頂点間隔が下限になるので、密にしないと天体半径よりずっと広い
      // 隙間が空く。
      const densifyNear = el && rel ? (el.e > 0.5 ? positionOnOrbit(el, 0) : rel) : undefined;
      const excludeNearBody = el && rel ? this.excludeNearBodyFor(id, el, rel) : undefined;
      line.sync(el, fo, false, densifyNear, excludeNearBody);
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

  // 参照軌道線はマップ専用。OrbitLine 1本につき固定Float32Arrayを確保するため、初回マップ
  // 表示まで生成を遅らせる。マップを離れても資源は保持し、再入場時の再構築を避ける。
  private ensureReferenceLines(): void {
    if (this.referenceLinesBuilt) return;
    this.referenceLinesBuilt = true;
    for (const id of referenceLineIds(this.ephemeris.registry)) {
      const color = bodyDef(this.ephemeris.registry, id).kind === 'satellite'
        ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
      const line = new OrbitLine(color, 0.2);
      line.line.renderOrder = 0;
      this.scene.add(line.line);
      this.referenceLines.set(id, line);
    }
  }

  // 天体は自らの軌道楕円上に乗っているため、その楕円をそのまま描くと天体メッシュと
  // depth が競合してチラつく(z-fighting)。天体の現在の離心近点角と半径を返し、
  // OrbitLine 側でその周辺のセグメントを間引かせる。rel は中心天体相対の現在位置。
  private excludeNearBodyFor(id: OrbitingId, el: OrbitalElements, rel: Vec3): { E: number; radius: number } {
    const nu = trueAnomalyAt(el, rel);
    const E = Math.atan2(Math.sqrt(1 - el.e * el.e) * Math.sin(nu), el.e + Math.cos(nu));
    return { E, radius: bodyDef(this.ephemeris.registry, id).radius };
  }

  // 参照線を引くかどうか。恒星は常時引く。惑星・準惑星・小天体は body-visibility.ts の
  // Orbit トグルに従う(Label トグルとは独立)。衛星も専用トグルに従う。
  // しているときだけ引く(地球系だけは例外で常時引く — プレイの中心なので、どこを見ていても
  // 月軌道が文脈として要る)。
  private showsReferenceLine(
    id: OrbitingId, focusId: AttractorId | undefined, toggles: BodyClassToggles,
    nearbyIds: readonly AttractorId[],
  ): boolean {
    const registry = this.ephemeris.registry;
    const cls = bodyClassOf(registry, id);
    if (cls === 'planet') return toggles.planetVisible && toggles.planetOrbit;
    if (cls === 'dwarf') return toggles.dwarfVisible && toggles.dwarfOrbit;
    if (cls === 'smallBody') return toggles.smallBodyVisible && toggles.smallBodyOrbit;
    const def = bodyDef(registry, id);
    if (def.kind !== 'satellite') return true;
    return toggles.satelliteVisible && toggles.satelliteOrbit
      && (def.planet === 'earth' || focusSystemOf(registry, focusId) === def.planet || nearbyIds.includes(id));
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
}
