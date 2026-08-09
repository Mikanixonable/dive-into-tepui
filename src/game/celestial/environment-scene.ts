// 環境(天体ビュー・星・天球グリッド・参照軌道線・環境光)の構築と毎フレーム更新。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH, SOLAR_SYSTEM, bodyDef } from '../../physics/solar-system';
import { OrbitalElements, positionOnOrbit } from '../../physics/elements';
import { Attractor, AttractorId, OrbitingId, PlanetId, orbitalElementsOf } from '../../physics/attractor';
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

// 公転天体の参照軌道線の色: 衛星は月軌道線の色、惑星は木星軌道線の色を踏襲し、
// 同じ種別の天体はすべて同じ色で引く。
const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;

// 恒星以外の全公転天体の id(SOLAR_SYSTEM の宣言順)。天体が増えれば参照線もここから自動で増える。
const REFERENCE_LINE_IDS = (Object.keys(SOLAR_SYSTEM) as AttractorId[]).filter(
  (id) => bodyDef(id).kind !== 'star',
) as readonly OrbitingId[];

// フォーカス中のラベル id が属する惑星系(その惑星の id)。惑星なら自身、衛星なら親惑星、
// ラグランジュ点ラベル(`<id>-l1` 等)ならその副天体で解決する。惑星系に属さないなら null。
function focusSystemOf(focusId: string): PlanetId | null {
  const bodyId = focusId.replace(/-l[1-5]$/, '');
  if (!(bodyId in SOLAR_SYSTEM)) return null;
  const def = bodyDef(bodyId as AttractorId);
  if (def.kind === 'planet') return def.id;
  return def.kind === 'satellite' ? def.planet : null;
}

export class EnvironmentScene {
  readonly ambient: THREE.AmbientLight;
  readonly starsMesh: THREE.Mesh;
  readonly celestialGrid: CelestialGrid;
  private readonly bodies: readonly CelestialBody[];
  private readonly sunBody: SunBody;

  // 静止軌道高度の参照リングは実在の天体ではないので、以下の天体駆動の配列とは別に持つ。
  readonly geoLine = new OrbitLine(0x8b93a0, 0.2);
  // 公転天体1体につき1本、SOLAR_SYSTEM から自動生成する参照軌道線(衛星は親惑星中心、
  // 惑星は太陽中心)。マップモード専用で、天体暦の状態から作られる表示なのでここが所有する。
  private readonly referenceLines: ReadonlyMap<OrbitingId, OrbitLine>;

  // 天体ビューの配列がすべて ephemeris から引く。天体暦はゲーム側が所有する単一インスタンスを
  // 共有参照する(状態を持たない純サンプラ)。
  constructor(
    scene: THREE.Scene,
    private readonly ephemeris: Ephemeris,
  ) {
    this.geoLine.line.renderOrder = 0;
    scene.add(this.geoLine.line);

    const referenceLines = new Map<OrbitingId, OrbitLine>();
    for (const id of REFERENCE_LINE_IDS) {
      const color = bodyDef(id).kind === 'satellite' ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
      const line = new OrbitLine(color, 0.2);
      line.line.renderOrder = 0;
      scene.add(line.line);
      referenceLines.set(id, line);
    }
    this.referenceLines = referenceLines;

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
    this.syncReferenceLines(displayTime, floatingOrigin, cameraSystem.overviewMode, cameraSystem.overviewCamera.focus);
    this.celestialGrid.sync(gridVisibility, cameraSystem);
  }

  // 星球はカメラに追従する固定半径の殻。広範囲視点では CELESTIAL_SHELL_RADIUS まで拡大する
  // (far は dist に連動して毎フレーム変わるため、殻の拡大率はそこから独立させる)。
  private syncStars(cameraSystem: CameraSystem): void {
    this.starsMesh.position.copy(cameraSystem.activeCamera.position);
    this.starsMesh.scale.setScalar(cameraSystem.overviewMode ? C.CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0);
  }

  // 広範囲視点のときだけ参照軌道線を表示する(戦闘ビューでは非表示)。
  private syncReferenceLines(simTime: number, fo: FloatingOrigin, overviewMode: boolean, focusId: string): void {
    if (!overviewMode) {
      this.geoLine.sync(null, fo);
      for (const line of this.referenceLines.values()) line.sync(null, fo);
      return;
    }
    this.geoLine.sync(GEO_ELEMENTS, fo, false);
    for (const [id, line] of this.referenceLines) {
      const show = this.showsReferenceLine(id, focusId);
      const el = show ? this.orbitElementsFor(id, simTime) : null;
      // 離心率の大きい軌道(彗星など)は近日点付近で曲率が急なので、そこへ頂点を寄せないと
      // 楕円が多角形として粗く見える。
      const densifyNear = el && el.e > 0.5 ? positionOnOrbit(el, 0) : undefined;
      line.sync(el, fo, false, densifyNear);
    }
  }

  // 参照線を引くかどうか。惑星線は常時引き、衛星線はその衛星が属する惑星系にフォーカスして
  // いるときだけ引く — 全衛星の線を同時に引くと内側太陽系が線で潰れるため。地球系だけは
  // 例外で常時引く(プレイの中心なので、どこを見ていても月軌道が文脈として要る)。
  private showsReferenceLine(id: OrbitingId, focusId: string): boolean {
    const def = bodyDef(id);
    if (def.kind !== 'satellite' || def.planet === 'earth') return true;
    return focusSystemOf(focusId) === def.planet;
  }

  // 公転天体の接触軌道要素(表示専用)。衛星は親惑星中心、惑星は太陽中心 — 中心天体自身も
  // ECI 上を動くので、固定 Attractor ではなくその時刻の状態を毎回引いて組む。
  private orbitElementsFor(id: OrbitingId, simTime: number): OrbitalElements | null {
    const def = bodyDef(id);
    const centerId: AttractorId = def.kind === 'satellite' ? def.planet : 'sun';
    const centerDef = bodyDef(centerId);
    const center: Attractor = {
      id: centerId, mu: centerDef.mu, radius: centerDef.radius, state: this.ephemeris.stateOf(centerId, simTime), degree2: null,
    };
    return orbitalElementsOf(this.ephemeris.stateOf(id, simTime), center);
  }
}
