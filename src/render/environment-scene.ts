// 環境(太陽・月・星・地球・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris, R_MOON, sunlitFactor } from '../physics/ephemeris';
import { MU_EARTH, R_EARTH, SIDEREAL_DAY, orbitState } from '../physics/orbital-state';
import { Elements } from '../physics/elements';
import { Attractor, elementsAround } from '../physics/attractor';
import { Vec3, len, norm, scale, sub, v3 } from '../physics/vec3';
import { createEarth, Earth } from './earth';
import { OrbitLine } from './orbitline';
import { MOON_VIS_DIST, SUN_DISTANCE, SUN_VISUAL_SIZE, Sun, createMoon, createStars, createSun } from './stars';
import { CelestialGrid, CelestialGridVisibility } from './celestial-grid';
import { CameraSystem } from '../game/camera/camera-system';
import { FloatingOrigin } from '../game/floating-origin';
import * as C from '../game/const';

// 地球メッシュは地球中心(ECI 原点)基準。group.position はその原点の描画フレーム位置。
const EARTH_CENTER = v3(0, 0, 0);

// 地球(原点に静止)。参照軌道線はいずれも地球中心の表示なので、この固定値を center として使う。
const EARTH_ATTRACTOR: Attractor = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: orbitState(0, v3(0, 0, 0), v3(0, 0, 0)) };

// 静止軌道高度の参照リング。実在の衛星や特定経度を表すものではない定数。
const GEO_ELEMENTS: Elements = {
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

// 太陽ビルボード位置(カメラ相対)の作業用 THREE.Vector3。毎フレームの再確保を避ける。
const tmpSunPos = new THREE.Vector3();

export class EnvironmentScene {
  readonly ambient: THREE.AmbientLight;
  readonly sun: Sun;
  readonly sunLight: THREE.DirectionalLight;
  readonly starsMesh: THREE.Mesh;
  readonly moonMesh: THREE.Mesh;
  readonly earth: Earth;
  readonly celestialGrid: CelestialGrid;

  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  // マップモード専用の参照軌道線(静止軌道高度の目盛り・月軌道)。どちらも天体暦の
  // 状態から作られる表示なので、環境描画とともにここが所有する。
  readonly geoLine = new OrbitLine(0x8b93a0, 0.2);
  readonly moonLine = new OrbitLine(0xaab3c0, 0.2);

  // 太陽方向のライティング・空の天体・参照軌道線がすべて ephemeris から引く。天体暦は
  // ゲーム側が所有する単一インスタンスを共有参照する(状態を持たない純サンプラ)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
  ) {
    const sd0 = this.ephemeris.sunDirAt(0);
    // マップ専用の参照軌道線をシーンへ追加する。
    this.geoLine.line.renderOrder = 0;
    this.moonLine.line.renderOrder = 0;
    scene.add(this.geoLine.line);
    scene.add(this.moonLine.line);
    // 光源と天体メッシュを構築してシーンへ追加する。
    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    scene.add(this.ambient);
    this.sun = createSun();
    scene.add(this.sun.billboard.mesh);
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
    this.sunLight.position.set(sd0.x * 1e5, sd0.y * 1e5, sd0.z * 1e5);
    scene.add(this.sunLight);
    this.moonMesh = createMoon();
    scene.add(this.moonMesh);
    this.starsMesh = createStars();
    scene.add(this.starsMesh);
    this.earth = createEarth();
    scene.add(this.earth.group);
    this.celestialGrid = new CelestialGrid(scene);
  }

  // 地球・空の天体・照明・参照線・天球グリッドを、この1フレームの表示状態に同期する。
  // playerPos は照明の日照率を引く基準位置。
  sync(
    dt: number,
    playerPos: Vec3,
    floatingOrigin: FloatingOrigin,
    displayTime: number,
    cameraSystem: CameraSystem,
    gridVisibility: CelestialGridVisibility,
  ): void {
    this.syncEarth(dt, floatingOrigin, displayTime);
    this.syncSkyBodies(displayTime, floatingOrigin, cameraSystem);

    // lit は自機位置の日照率(円柱影の近似)。物理的に正確ではない。
    const lit = cameraSystem.overviewMode ? 1.0 : sunlitFactor(playerPos, this.ephemeris.sunDirAt(displayTime), C.SHADOW_PENUMBRA);
    this.syncLighting(lit);

    this.syncReferenceLines(displayTime, floatingOrigin, cameraSystem.overviewMode);
    this.celestialGrid.sync(gridVisibility, cameraSystem);
  }

  // 広範囲視点のときだけ geo/moon の参照線を表示する(戦闘ビューでは非表示)。
  private syncReferenceLines(simTime: number, fo: FloatingOrigin, overviewMode: boolean): void {
    if (!overviewMode) {
      this.geoLine.sync(null, fo);
      this.moonLine.sync(null, fo);
      return;
    }
    this.geoLine.sync(GEO_ELEMENTS, fo, false);
    this.moonLine.sync(this.moonOrbitElements(simTime), fo, false);
  }

  // 月の接触軌道要素(表示専用)。月自身は entity ではなく解析式のみを持つため、
  // 近接2点の位置を数値微分して疑似的な r, v を作り、他の軌道線と同じ経路に載せる。
  private moonOrbitElements(simTime: number): Elements | null {
    const dt = 10;
    const r1 = this.ephemeris.moonPosAt(simTime);
    const r2 = this.ephemeris.moonPosAt(simTime + dt);
    const state = orbitState(simTime, r1, scale(sub(r2, r1), 1 / dt));
    return elementsAround(state, EARTH_ATTRACTOR);
  }

  // 地球の位置・自転角・表面アニメーションを表示時刻に同期する。
  private syncEarth(dt: number, fo: FloatingOrigin, displayTime: number): void {
    this.earth.group.position.copy(fo.RtoThreeV3(EARTH_CENTER));
    this.earth.setRotation(this.earthPhase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    this.earth.tick(dt, displayTime);
  }

  // 太陽・月・星の見た目位置とライティング方向を、表示時刻とカメラに応じて同期する。
  private syncSkyBodies(
    displayTime: number,
    fo: FloatingOrigin,
    cameraSystem: CameraSystem,
  ): void {
    const visSunPos = this.ephemeris.sunPosAt(displayTime);
    const cam = cameraSystem.activeCamera;
    const sd = norm(visSunPos);
    this.earth.setSunDir(sd.x, sd.y, sd.z);
    this.starsMesh.position.copy(cam.position);
    this.starsMesh.scale.setScalar(
      cameraSystem.overviewMode ? (cameraSystem.overviewCamera.camera.far * 0.9) / 3.5e7 : 1.0);
    // 太陽ビルボードはカメラ相対(空の遠景)。fo 由来の変換ではないので camera 位置基準で置く。
    // 方向は地心方向 sd ではなく「カメラから見た太陽の方向」を使う: 広範囲視点はカメラが
    // 地球から最大 4.5e9 m 離れるため、地心方向で置くと視差ぶん(最大 1.7°)実位置からずれ、
    // 実 ECI 位置に置かれる太陽ラベルと像が合わなくなる。
    const sdCam = norm(sub(visSunPos, cameraSystem.activeCameraPos));
    this.sun.billboard.sync(
      tmpSunPos.set(
        cam.position.x + sdCam.x * SUN_DISTANCE,
        cam.position.y + sdCam.y * SUN_DISTANCE,
        cam.position.z + sdCam.z * SUN_DISTANCE,
      ),
      SUN_VISUAL_SIZE,
      1,
      cam.quaternion,
    );
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    const visMoonPos = this.ephemeris.moonPosAt(displayTime);
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 月を実 ECI 位置(fo 経由)に置く。
      this.moonMesh.position.copy(fo.RtoThreeV3(visMoonPos));
      this.moonMesh.scale.setScalar(R_MOON);
    } else {
      // 戦闘視点はカメラ相対の表示距離。月の fo 相対ベクトルは方向・距離の算出に使う。
      this.placeCombatMoon(cam, sub(visMoonPos, cameraSystem.activeCameraPos), R_MOON, MOON_VIS_DIST);
    }
    this.moonMesh.lookAt(
      this.moonMesh.position.x - visMoonPos.x,
      this.moonMesh.position.y - visMoonPos.y,
      this.moonMesh.position.z - visMoonPos.z,
    );
  }

  // 通常戦闘視点: 月をカメラからの一定表示距離に置き、実距離に応じた見かけの大きさへスケールする。
  private placeCombatMoon(cam: THREE.PerspectiveCamera, moonRel: Vec3, moonRadius: number, moonVisDist: number): void {
    const moonDist = len(moonRel);
    const md = scale(moonRel, 1 / moonDist);
    this.moonMesh.position.set(
      cam.position.x + md.x * moonVisDist,
      cam.position.y + md.y * moonVisDist,
      cam.position.z + md.z * moonVisDist,
    );
    this.moonMesh.scale.setScalar(moonVisDist * (moonRadius / moonDist));
  }

  // 日照率 lit(0..1)に応じて太陽光・環境光の強度を落とす。
  private syncLighting(lit: number): void {
    this.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.ambient.intensity = C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);
  }
}
