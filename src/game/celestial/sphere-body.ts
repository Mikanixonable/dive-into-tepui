// 「テクスチャ球 + 表示距離圧縮」で済む天体(月・木星など)の見た目。実距離のまま描くと
// 戦闘視点では点にしかならないため、カメラから固定距離 visDist に置き、
// visDist * radius / trueDist で見かけの角直径を実際の距離に応じて正しく保つ。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { len, scale, sub } from '../../physics/vec3';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { CelestialSurface } from '../../render/celestial-surface';
import { CelestialBody } from './celestial-body';
import { RingView } from './ring-view';

export class SphereBody extends CelestialBody {
  readonly id: OrbitingId;
  private surface!: CelestialSurface;
  private mesh!: THREE.Mesh;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;
  private ring?: RingView;

  // buildSurface は build() で表面を作る遅延コンストラクタ、radius/visDist は実半径 [m] と
  // 戦闘視点での表示距離 [m]、shape は歪みの形状データ(省略時は radius による真球)。
  // rings を渡すと環を持つ天体になる(ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    private readonly buildSurface: () => CelestialSurface,
    private readonly radius: number,
    private readonly visDist: number,
    shape?: ShapeDef,
    private readonly rings?: RingSystemDef,
  ) {
    super();
    this.id = id;
    const a = shapeAxes(radius, shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
  }

  // buildSurface で表面を組み立て、シーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.surface = this.buildSurface();
    this.mesh = this.surface.mesh;
    scene.add(this.mesh);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.mesh.renderOrder + 1);
      scene.add(this.ring.group);
    }
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
    if (this.ring !== undefined) this.ring.group.visible = visible;
  }

  // displayTime 時点の位置へ、視点モードに応じた実スケール/圧縮距離のどちらかで同期する。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    if (!this.mesh.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    // 陰影は真の位置から見た恒星方向で決める — 戦闘視点では描画位置が圧縮されているため、
    // 描画位置から引くと昼夜境界が実際とずれる。
    const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
    this.surface.setSunDirection(sunDirection);
    let scaleFactor: number;
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 実 ECI 位置に実半軸で置く。
      this.mesh.position.copy(fo.RtoThreeV3(pos));
      scaleFactor = this.radius;
    } else {
      const cam = cameraSystem.activeCamera;
      const rel = sub(pos, cameraSystem.activeCameraPos);
      const dist = len(rel);
      const dir = scale(rel, 1 / dist);
      this.mesh.position.set(
        cam.position.x + dir.x * this.visDist,
        cam.position.y + dir.y * this.visDist,
        cam.position.z + dir.z * this.visDist,
      );
      scaleFactor = this.visDist * (this.radius / dist);
    }
    // 歪んだ天体は3軸それぞれの半軸へ同じ倍率を掛ける — 真の視角を保つ性質は変わらない。
    // 環へ渡すのは倍率のもとになる一様スケール(赤道半径基準)の方で、扁平は乗せない。
    const k = scaleFactor / this.radius;
    this.mesh.scale.set(this.axes.x * k, this.axes.y * k, this.axes.z * k);
    // モデル座標は +Y が自転軸、+Z が本初子午線。同期回転する天体はこれで親を向き続ける。
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q !== null) this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    this.surface.setRingShadowSystem(
      this.rings,
      this.mesh.position,
      this.radius,
      scaleFactor,
      orientation === null ? null : orientation.axis,
    );
    if (this.ring !== undefined) {
      this.ring.sync(
        this.mesh.position,
        scaleFactor,
        orientation === null ? null : orientation.axis,
        pos,
        cameraSystem.activeCameraScale,
        sunDirection,
        cameraSystem.activeCamera.position,
      );
    }
  }
}
