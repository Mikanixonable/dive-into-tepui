// 「テクスチャ球 + 表示距離圧縮」で済む天体(月・木星など)の見た目。実距離のまま描くと
// 戦闘視点では点にしかならないため、カメラから固定距離 visDist に置き、
// visDist * radius / trueDist で見かけの角直径を実際の距離に応じて正しく保つ。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { len, scale, sub } from '../../physics/vec3';
import { RingSystemDef, RingTextureId } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { CelestialBody } from './celestial-body';
import { RingView } from './ring-view';

export class SphereBody extends CelestialBody {
  readonly id: OrbitingId;
  private mesh!: THREE.Mesh;
  private ring?: RingView;

  // buildMesh は build() でメッシュを作る遅延コンストラクタ、radius/visDist は実半径 [m] と
  // 戦闘視点での表示距離 [m]。rings/ringTextures を渡すと環を持つ天体になる(ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    private readonly buildMesh: () => THREE.Mesh,
    private readonly radius: number,
    private readonly visDist: number,
    private readonly rings?: RingSystemDef,
    private readonly ringTextures?: Readonly<Partial<Record<RingTextureId, string>>>,
  ) {
    super();
    this.id = id;
  }

  // buildMesh でメッシュを組み立て、シーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.mesh = this.buildMesh();
    scene.add(this.mesh);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.ringTextures ?? {});
      this.ring.group.renderOrder = this.mesh.renderOrder + 1;
      scene.add(this.ring.group);
    }
  }

  // displayTime 時点の位置へ、視点モードに応じた実スケール/圧縮距離のどちらかで同期する。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    const pos = ephemeris.positionOf(this.id, displayTime);
    let scaleFactor: number;
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 実 ECI 位置に実半径で置く。
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
    this.mesh.scale.setScalar(scaleFactor);
    // モデル座標は +Y が自転軸、+Z が本初子午線。同期回転する天体はこれで親を向き続ける。
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q !== null) this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    if (this.ring !== undefined) {
      this.ring.sync(this.mesh.position, scaleFactor, orientation === null ? null : orientation.axis, pos, cameraSystem.activeCameraScale);
    }
  }
}
