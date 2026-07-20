// 環境(太陽・月・星・地球・環境光)の構築と毎フレーム更新。
// game.ts のゲームプレイ定数(const.ts)には依存しない — 必要な値は呼び出し側から渡す。
import * as THREE from 'three/webgpu';
import { R_MOON, moonPosition, sunPosition } from '../physics/ephemeris';
import { SIDEREAL_DAY } from '../physics/orbital';
import { Vec3, len, norm, scale, sub } from '../physics/vec3';
import { createEarth, Earth } from './earth';
import { MOON_VIS_DIST, SUN_DISTANCE, Sun, createMoon, createStars, createSun } from './stars';
import { getGlowTexture } from './glow-texture';

export interface EnvironmentLightingParams {
  sunIntensity: number;
  ambientIntensity: number;
  shadowMinSun: number;
  shadowMinAmbient: number;
}

export interface EnvironmentRenderParams {
  dt: number;
  origin: Vec3;
  displayTime: number;
  camera: THREE.PerspectiveCamera;
  sunPhase0: number;
  moonPhase0: number;
  mapMode: boolean;
  mapCameraFar: number;
  lit: number;
}

export class EnvironmentScene {
  readonly ambient: THREE.AmbientLight;
  readonly sun: Sun;
  readonly sunLight: THREE.DirectionalLight;
  readonly starsMesh: THREE.Mesh;
  readonly moonMesh: THREE.Mesh;
  readonly earth: Earth;
  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  constructor(
    scene: THREE.Scene,
    sunDir0: Vec3,
    private readonly lighting: EnvironmentLightingParams,
  ) {
    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    scene.add(this.ambient);
    this.sun = createSun(getGlowTexture());
    scene.add(this.sun.mesh);
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, lighting.sunIntensity);
    this.sunLight.position.set(sunDir0.x * 1e5, sunDir0.y * 1e5, sunDir0.z * 1e5);
    scene.add(this.sunLight);
    this.moonMesh = createMoon();
    scene.add(this.moonMesh);
    this.starsMesh = createStars();
    scene.add(this.starsMesh);
    this.earth = createEarth();
    scene.add(this.earth.group);
  }

  syncRenderEnvironment(params: EnvironmentRenderParams): void {
    const { dt, origin, displayTime, camera, sunPhase0, moonPhase0, mapMode, mapCameraFar, lit } = params;
    this.updateEarth(dt, origin, displayTime);
    this.updateSkyBodies(displayTime, origin, camera, sunPhase0, moonPhase0, mapMode, mapCameraFar);
    this.updateLighting(lit);
  }

  private updateEarth(dt: number, origin: Vec3, displayTime: number): void {
    this.earth.group.position.set(-origin.x, -origin.y, -origin.z);
    this.earth.setRotation(this.earthPhase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    this.earth.tick(dt, displayTime);
  }

  private updateSkyBodies(
    displayTime: number,
    origin: Vec3,
    cam: THREE.PerspectiveCamera,
    sunPhase0: number,
    moonPhase0: number,
    mapMode: boolean,
    mapCameraFar: number,
  ): void {
    const visSunPos = sunPosition(displayTime, sunPhase0);
    const sd = norm(visSunPos);
    this.earth.setSunDir(sd.x, sd.y, sd.z);
    this.starsMesh.position.copy(cam.position);
    this.starsMesh.scale.setScalar(mapMode ? (mapCameraFar * 0.9) / 3.5e7 : 1.0);
    this.sun.mesh.position.set(
      cam.position.x + sd.x * SUN_DISTANCE,
      cam.position.y + sd.y * SUN_DISTANCE,
      cam.position.z + sd.z * SUN_DISTANCE,
    );
    this.sun.mesh.quaternion.copy(cam.quaternion);
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    const visMoonPos = moonPosition(displayTime, moonPhase0);
    const moonRel = sub(visMoonPos, origin);
    if (mapMode) {
      this.moonMesh.position.set(moonRel.x, moonRel.y, moonRel.z);
      this.moonMesh.scale.setScalar(R_MOON);
    } else {
      this.placeCombatMoon(cam, moonRel, R_MOON, MOON_VIS_DIST);
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

  private updateLighting(lit: number): void {
    const { sunIntensity, ambientIntensity, shadowMinSun, shadowMinAmbient } = this.lighting;
    this.sunLight.intensity = sunIntensity * (shadowMinSun + (1 - shadowMinSun) * lit);
    this.ambient.intensity = ambientIntensity * (shadowMinAmbient + (1 - shadowMinAmbient) * lit);
  }
}
