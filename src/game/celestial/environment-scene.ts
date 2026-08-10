// 環境(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { kinematicState } from '../../physics/kinematic-state';
import { CelestialRegistry, SolarSystemId, bodyDef, primaryOf } from '../../physics/solar-system';
import { OrbitalElements, positionOnOrbit } from '../../physics/elements';
import { Attractor, AttractorId, OrbitingId, orbitalElementsOf } from '../../physics/attractor';
import { Vec3, v3 } from '../../physics/vec3';
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
import { bodyClassOf } from './body-class';
import { BodyClassToggles } from './body-visibility';

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
  readonly ambient: THREE.AmbientLight;
  // 描画原点の近傍にある実スケールの物体(自機・デブリ・薬莢)を照らす平行光。天体は
  // 描画位置が真の位置と一致しないためこの光を受けず、自分で陰影を計算する。
  private readonly sunLight: THREE.DirectionalLight;
  readonly starsMesh: THREE.Mesh;
  readonly celestialGrid: CelestialGrid;
  private readonly bodies: readonly CelestialBody[];
  // 小惑星帯・トロヤ群の点群。天体暦から作られるマップ専用の表示なのでここが所有する。
  private readonly pointFieldView = new PointFieldView();

  // 静止軌道高度の参照リングは実在の天体ではないので、以下の天体駆動の配列とは別に持つ。
  // 地球が現在のレジストリに無ければ null(sync は非表示のまま何もしない)。
  readonly geoLine = new OrbitLine(0x8b93a0, 0.2);
  private readonly geoElements: OrbitalElements | null;
  // 公転天体1体につき1本、registry から自動生成する参照軌道線(衛星は親惑星中心、
  // 惑星は太陽中心)。マップモード専用で、天体暦の状態から作られる表示なのでここが所有する。
  private readonly referenceLines: ReadonlyMap<OrbitingId, OrbitLine>;

  // 天体ビューの配列がすべて ephemeris から引く。天体暦はゲーム側が所有する単一インスタンスを
  // 共有参照する(状態を持たない純サンプラ)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
  ) {
    const registry = ephemeris.registry;
    this.geoLine.line.renderOrder = 0;
    scene.add(this.geoLine.line);
    this.geoElements = buildGeoElements(registry);

    const referenceLines = new Map<OrbitingId, OrbitLine>();
    for (const id of referenceLineIds(registry)) {
      const color = bodyDef(registry, id).kind === 'satellite' ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
      const line = new OrbitLine(color, 0.2);
      line.line.renderOrder = 0;
      scene.add(line.line);
      referenceLines.set(id, line);
    }
    this.referenceLines = referenceLines;

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
    this.pointFieldView.build(scene);
  }

  // 表示時刻 t の点群の位置を更新する。
  update(t: number, overviewMode: boolean): void {
    this.pointFieldView.update(t, overviewMode, this.ephemeris);
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

    this.pointFieldView.sync(floatingOrigin, cameraSystem.overviewMode);
    this.syncStars(cameraSystem);
    this.syncReferenceLines(
      displayTime, floatingOrigin, cameraSystem.overviewMode,
      focusTargetId(cameraSystem.overviewCamera.focus), cameraSystem.bodyClassToggles);
    this.celestialGrid.sync(gridVisibility, cameraSystem);
  }

  // 星球はカメラに追従する固定半径の殻。広範囲視点では CELESTIAL_SHELL_RADIUS まで拡大する
  // (far は dist に連動して毎フレーム変わるため、殻の拡大率はそこから独立させる)。
  private syncStars(cameraSystem: CameraSystem): void {
    this.starsMesh.position.copy(cameraSystem.activeCamera.position);
    this.starsMesh.scale.setScalar(cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
  }

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。
  private syncReferenceLines(
    simTime: number, fo: FloatingOrigin, overviewMode: boolean, focusId: AttractorId | undefined, toggles: BodyClassToggles,
  ): void {
    if (!overviewMode) {
      this.geoLine.sync(null, fo);
      for (const line of this.referenceLines.values()) line.sync(null, fo);
      return;
    }
    this.geoLine.sync(this.geoElements, fo, false);
    for (const [id, line] of this.referenceLines) {
      const show = this.showsReferenceLine(id, focusId, toggles);
      const el = show ? this.orbitElementsFor(id, simTime) : null;
      // 離心率の大きい軌道(彗星など)は近日点付近で曲率が急なので、そこへ頂点を寄せないと
      // 楕円が多角形として粗く見える。
      const densifyNear = el && el.e > 0.5 ? positionOnOrbit(el, 0) : undefined;
      line.sync(el, fo, false, densifyNear);
    }
  }

  // 参照線を引くかどうか。恒星・惑星本体は常時引く。衛星はその衛星が属する惑星系に
  // フォーカスしているときだけ引く(地球系だけは例外で常時引く — プレイの中心なので、
  // どこを見ていても月軌道が文脈として要る)。準惑星・小天体は body-visibility.ts の
  // Orbit トグルに従う(Label トグルとは独立)。
  private showsReferenceLine(id: OrbitingId, focusId: AttractorId | undefined, toggles: BodyClassToggles): boolean {
    const registry = this.ephemeris.registry;
    const cls = bodyClassOf(registry, id);
    if (cls === 'dwarf') return toggles.dwarfOrbit;
    if (cls === 'smallBody') return toggles.smallBodyOrbit;
    const def = bodyDef(registry, id);
    if (def.kind !== 'satellite' || def.planet === 'earth') return true;
    return focusSystemOf(registry, focusId) === def.planet;
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
