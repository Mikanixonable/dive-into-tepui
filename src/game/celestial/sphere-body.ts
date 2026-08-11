// 「テクスチャ球 + 表示距離圧縮」で済む天体(月・木星など)の見た目。実距離のまま描くと
// 戦闘視点では点にしかならないため、カメラから固定距離 visDist に置き、
// visDist * radius / trueDist で見かけの角直径を実際の距離に応じて正しく保つ。
// 球メッシュは screen-lod.ts の分割段ラダーに乗る: 段ごとに単位球メッシュを作り分けて
// おき(WebGPU は mesh.geometry の差し替えが効かないため)、真の位置での見かけ直径から
// 選んだ1段だけを visible にする。見かけ直径が閾値未満なら球自体を描かない。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { len, scale, sub } from '../../physics/vec3';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { apparentSizePx, showsPhysicalSphere, sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from '../../render/screen-lod';
import { CelestialSurface } from '../../render/celestial-surface';
import { CelestialBody } from './celestial-body';
import { RingView } from './ring-view';

export class SphereBody extends CelestialBody {
  readonly id: OrbitingId;
  private readonly surfaces: ReadonlyMap<SphereLodLevel, CelestialSurface>;
  private readonly group = new THREE.Group();
  private activeLevel: SphereLodLevel | null = null;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;
  // 環を含めた最外半径 [m]。radius だけで見かけ直径を判定すると、本体が閾値未満でも
  // 環がまだ画面に見える大きさのまま球体ごと隠してしまう。
  private readonly outerRadius: number;
  private ring?: RingView;

  // buildSurface は分割段(screen-lod.ts の SPHERE_LOD_LADDER の要素)ごとに表面を作る
  // 遅延コンストラクタ、radius/visDist は実半径 [m] と戦闘視点での表示距離 [m]、shape は
  // 歪みの形状データ(省略時は radius による真球)。rings を渡すと環を持つ天体になる
  // (ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    buildSurface: (level: SphereLodLevel) => CelestialSurface,
    private readonly radius: number,
    private readonly visDist: number,
    shape?: ShapeDef,
    private readonly rings?: RingSystemDef,
  ) {
    super();
    this.id = id;
    const a = shapeAxes(radius, shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
    this.outerRadius = rings === undefined
      ? radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), radius);
    const surfaces = new Map<SphereLodLevel, CelestialSurface>();
    for (const level of SPHERE_LOD_LADDER) {
      const surface = buildSurface(level);
      surface.mesh.visible = false;
      surfaces.set(level, surface);
    }
    this.surfaces = surfaces;
  }

  // 分割段ごとの表面メッシュと環をシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    for (const surface of this.surfaces.values()) this.group.add(surface.mesh);
    scene.add(this.group);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.group.renderOrder + 1);
      scene.add(this.ring.group);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (this.ring !== undefined) this.ring.group.visible = visible;
  }

  // displayTime 時点の位置へ、視点モードに応じた実スケール/圧縮距離のどちらかで同期する。
  // 見かけ直径は圧縮前の真の位置から求め、閾値未満なら球自体(と環)を描かない。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    if (!this.group.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    const apparentDiameterPx = apparentSizePx(2 * this.outerRadius, cameraSystem.activeCameraScale(pos));
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      return;
    }
    this.syncLod(apparentDiameterPx);
    const activeSurface = this.surfaces.get(this.activeLevel!)!;
    // 陰影は真の位置から見た恒星方向で決める — 戦闘視点では描画位置が圧縮されているため、
    // 描画位置から引くと昼夜境界が実際とずれる。
    const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
    activeSurface.setSunDirection(sunDirection);
    let scaleFactor: number;
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 実 ECI 位置に実半軸で置く。
      this.group.position.copy(fo.RtoThreeV3(pos));
      scaleFactor = this.radius;
    } else {
      const cam = cameraSystem.activeCamera;
      const rel = sub(pos, cameraSystem.activeCameraPos);
      const dist = len(rel);
      const dir = scale(rel, 1 / dist);
      this.group.position.set(
        cam.position.x + dir.x * this.visDist,
        cam.position.y + dir.y * this.visDist,
        cam.position.z + dir.z * this.visDist,
      );
      scaleFactor = this.visDist * (this.radius / dist);
    }
    // 歪んだ天体は3軸それぞれの半軸へ同じ倍率を掛ける — 真の視角を保つ性質は変わらない。
    // 環へ渡すのは倍率のもとになる一様スケール(赤道半径基準)の方で、扁平は乗せない。
    const k = scaleFactor / this.radius;
    this.group.scale.set(this.axes.x * k, this.axes.y * k, this.axes.z * k);
    // モデル座標は +Y が自転軸、+Z が本初子午線。同期回転する天体はこれで親を向き続ける。
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    activeSurface.setRingShadowSystem(
      this.rings,
      this.group.position,
      this.radius,
      scaleFactor,
      orientation === null ? null : orientation.axis,
    );
    if (this.ring !== undefined) {
      this.ring.group.visible = true;
      this.ring.sync(
        this.group.position,
        scaleFactor,
        orientation === null ? null : orientation.axis,
        pos,
        cameraSystem.activeCameraScale,
        sunDirection,
        cameraSystem.activeCamera.position,
      );
    }
  }

  // 見かけ直径が閾値未満のときの共通後始末: 全段のメッシュと環を隠す。
  private hidePhysical(): void {
    for (const surface of this.surfaces.values()) surface.mesh.visible = false;
    this.activeLevel = null;
    if (this.ring !== undefined) this.ring.group.visible = false;
  }

  // 見かけ直径から球分割段を選び、その段のメッシュだけを visible にする。
  private syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [lvl, surface] of this.surfaces) surface.mesh.visible = lvl === level;
  }
}
