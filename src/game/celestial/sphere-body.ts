// 「テクスチャ球 + 表示距離圧縮」で済む天体(月・木星など)の見た目。実距離のまま描くと
// 戦闘視点では点にしかならないため、カメラから固定距離 visDist に置き、
// visDist * radius / trueDist で見かけの角直径を実際の距離に応じて正しく保つ。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { len, scale, sub } from '../../physics/vec3';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { CelestialBody } from './celestial-body';

export class SphereBody extends CelestialBody {
  readonly id: OrbitingId;
  private mesh!: THREE.Mesh;

  // buildMesh は build() でメッシュを作る遅延コンストラクタ、radius/visDist は実半径 [m] と
  // 戦闘視点での表示距離 [m]。buildRing を渡すと環を持つ天体になる — 環は本体メッシュの
  // 子として付き、赤道面の姿勢と表示スケールをそのまま継承する。
  constructor(
    id: OrbitingId,
    private readonly buildMesh: () => THREE.Mesh,
    private readonly radius: number,
    private readonly visDist: number,
    private readonly buildRing?: () => THREE.Object3D,
  ) {
    super();
    this.id = id;
  }

  // buildMesh でメッシュを組み立て、シーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.mesh = this.buildMesh();
    if (this.buildRing !== undefined) {
      const ring = this.buildRing();
      ring.renderOrder = this.mesh.renderOrder + 1;
      this.mesh.add(ring);
    }
    scene.add(this.mesh);
  }

  // displayTime 時点の位置へ、視点モードに応じた実スケール/圧縮距離のどちらかで同期する。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    const pos = ephemeris.positionOf(this.id, displayTime);
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 実 ECI 位置に実半径で置く。
      this.mesh.position.copy(fo.RtoThreeV3(pos));
      this.mesh.scale.setScalar(this.radius);
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
      this.mesh.scale.setScalar(this.visDist * (this.radius / dist));
    }
    // モデル座標は +Y が自転軸、+Z が本初子午線。同期回転する天体はこれで親を向き続ける。
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q !== null) this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }
}
