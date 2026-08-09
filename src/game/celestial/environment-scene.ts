// 環境(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, MU_SUN, R_EARTH, R_SUN } from '../../physics/solar-system';
import { OrbitalElements } from '../../physics/elements';
import { Attractor, orbitalElementsOf } from '../../physics/attractor';
import { Vec3, v3 } from '../../physics/vec3';
import { OrbitLine } from '../../render/orbit-line';
import { createStars, STAR_SHELL_RADIUS } from '../../render/stars';
import { CelestialGrid, CelestialGridVisibility } from '../../render/celestial-grid';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { CelestialBody } from './celestial-body';
import { CELESTIAL_BODIES } from './celestial-registry';
import { SunBody } from './sun-body';

// 地球(原点に静止)。参照軌道線はいずれも地球中心の表示なので、この固定値を center として使う。
// 楕円を描く基準としてしか使わないため、2次重力場は解決しない。
const EARTH_ATTRACTOR: Attractor = {
  id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), degree2: null,
};

// 静止軌道高度の参照リング。実在の衛星や特定経度を表すものではない定数。
const GEO_ELEMENTS: OrbitalElements = {
  a: R_EARTH + 35786e3,
  e: 1e-6,
  p: R_EARTH + 35786e3,
  incDeg: 0,
  period: 86164,
  hHat: v3(0, 1, 0),
  pHat: v3(1, 0, 0),
  qHat: v3(0, 0, -1),
  center: EARTH_ATTRACTOR,
};

export class EnvironmentScene {
  readonly ambient: THREE.AmbientLight;
  readonly starsMesh: THREE.Mesh;
  readonly celestialGrid: CelestialGrid;
  private readonly bodies: readonly CelestialBody[];
  private readonly sunBody: SunBody;

  // マップモード専用の参照軌道線(静止軌道高度の目盛り・月軌道・地球軌道・木星軌道)。
  // いずれも天体暦の状態から作られる表示なので、環境描画とともにここが所有する。
  readonly geoLine = new OrbitLine(0x8b93a0, 0.2);
  readonly moonLine = new OrbitLine(0xaab3c0, 0.2);
  readonly earthLine = new OrbitLine(0xaab3c0, 0.2);
  readonly jupiterLine = new OrbitLine(0xffffff, 0.2);

  // 天体ビューの配列がすべて ephemeris から引く。天体暦はゲーム側が所有する単一インスタンスを
  // 共有参照する(状態を持たない純サンプラ)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
  ) {
    // マップ専用の参照軌道線をシーンへ追加する。
    this.geoLine.line.renderOrder = 0;
    this.moonLine.line.renderOrder = 0;
    this.earthLine.line.renderOrder = 0;
    this.jupiterLine.line.renderOrder = 0;
    scene.add(this.geoLine.line);
    scene.add(this.moonLine.line);
    scene.add(this.earthLine.line);
    scene.add(this.jupiterLine.line);
    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    scene.add(this.ambient);
    this.starsMesh = createStars();
    scene.add(this.starsMesh);
    this.celestialGrid = new CelestialGrid(scene);

    this.bodies = Object.values(CELESTIAL_BODIES).map((v) => v.create());
    this.sunBody = this.bodies.find((b): b is SunBody => b.id === 'sun')!;
    for (const body of this.bodies) body.build(scene);
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
    // lit は自機位置の日照率(円柱影の近似)。物理的に正確ではない。
    const lit = cameraSystem.overviewMode ? 1.0 : sunlitFactor(playerPos, this.ephemeris.sunDirAt(displayTime), C.SHADOW_PENUMBRA);
    this.sunBody.setSunlit(lit);
    for (const body of this.bodies) body.sync(floatingOrigin, displayTime, cameraSystem, this.ephemeris);
    this.ambient.intensity = C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);

    this.syncStars(cameraSystem);
    this.syncReferenceLines(displayTime, floatingOrigin, cameraSystem.overviewMode);
    this.celestialGrid.sync(gridVisibility, cameraSystem);
  }

  // 星球はカメラに追従する固定半径の殻。広範囲視点では CELESTIAL_SHELL_RADIUS まで拡大する
  // (far は dist に連動して毎フレーム変わるため、殻の拡大率はそこから独立させる)。
  private syncStars(cameraSystem: CameraSystem): void {
    this.starsMesh.position.copy(cameraSystem.activeCamera.position);
    this.starsMesh.scale.setScalar(cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
  }

  // 広範囲視点のときだけ geo/moon/jupiter の参照線を表示する(戦闘ビューでは非表示)。
  private syncReferenceLines(simTime: number, fo: FloatingOrigin, overviewMode: boolean): void {
    if (!overviewMode) {
      this.geoLine.sync(null, fo);
      this.moonLine.sync(null, fo);
      this.jupiterLine.sync(null, fo);
      return;
    }
    this.geoLine.sync(GEO_ELEMENTS, fo, false);
    this.moonLine.sync(this.moonOrbitElements(simTime), fo, false);
    this.jupiterLine.sync(this.jupiterOrbitElements(simTime), fo, false);
  }

  // 月の接触軌道要素(表示専用)。月自身は entity ではなく解析式のみを持つため、
  // ephemeris の解析状態をそのまま他の軌道線と同じ経路に載せる。
  private moonOrbitElements(simTime: number): OrbitalElements | null {
    return orbitalElementsOf(this.ephemeris.stateOf('moon', simTime), EARTH_ATTRACTOR);
  }

  // 木星の接触軌道要素(表示専用)。木星は太陽中心の軌道なので、太陽自身も ECI 上を
  // 動く以上、地球のような固定 Attractor では組めず、太陽の現在状態を毎回引く。
  private jupiterOrbitElements(simTime: number): OrbitalElements | null {
    const sun: Attractor = {
      id: 'sun', mu: MU_SUN, radius: R_SUN, state: this.ephemeris.stateOf('sun', simTime), degree2: null,
    };
    return orbitalElementsOf(this.ephemeris.stateOf('jupiter', simTime), sun);
  }
}
