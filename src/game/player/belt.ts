// マガジンベルトの表示メッシュ(機体への追加、各リンクの Group)を管理する。
// たわみ・ねじれの物理演算そのものは belt-physics.ts の BeltPhysics(算術専用、
// メッシュを持たない)に委譲し、このファイルは物理の結果(beltPos/beltTwist/anchor)
// から各リンクの位置・向きを導出してメッシュへ反映するモデル管理の責務を持つ。
import * as THREE from 'three/webgpu';
import { Attitude, Quat, qFromAxisAngle, qFromUnitVectors, qMul, qRotate } from '../../physics/attitude';
import { Vec3, len, scale, sub } from '../../physics/vec3';
import * as C from '../const';
import { MAG_BELT_PITCH, buildMagazineMesh } from '../../render/ships';
import { BeltSection } from '../orbit-entity/entities';
import { BeltPhysics, X_AXIS } from './belt-physics';

const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class Belt {
  private readonly links: THREE.Group[] = [];
  private readonly physics: BeltPhysics;
  private feed = 0;
  private visibleCount = 0;

  constructor(playerObj: THREE.Object3D) {
    const group = new THREE.Group();
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = 0.9 + i * MAG_BELT_PITCH;
      group.add(link);
      this.links.push(link);
    }
    playerObj.add(group);
    this.physics = new BeltPhysics(this.links.length);
  }

  // 見えているリンク数と、たわみアンカーの給弾進み(beltFeed)を弾薬状態から
  // 導出し、たわみ物理(BeltPhysics)を進める。メッシュへの反映は sync() が行う。
  update(
    dt: number,
    magsLeft: number,
    roundsInMag: number,
    att: Attitude,
    thrustAccelVec: Vec3,
  ): void {
    this.visibleCount = Math.min(magsLeft, C.BELT_MAX_VISIBLE);
    const targetFeed = 1 - roundsInMag / C.MAG_ROUNDS;
    if (targetFeed < this.feed - 0.5) {
      this.physics.shiftBeltNodes();
      this.feed = targetFeed;
    } else {
      this.feed += (targetFeed - this.feed) * Math.min(1, dt * 12);
    }
    this.physics.update(dt, att, thrustAccelVec, this.feed);
  }

  // 確定済みの物理状態(BeltPhysics.beltPos/beltTwist、three 非依存の Vec3/Quat)から
  // 各リンクの位置・向きを導出し、THREE.Object3D へ反映する。位置は「平行移動
  // (parallel transport)」で求める: 前リンクの姿勢を基準に、その進行方向
  // (ローカル+X)を新しい節点方向へ向ける最小回転だけを加える。
  sync(alive: boolean): void {
    const { beltPos, beltTwist, anchor } = this.physics;
    let prevPoint = anchor;
    let prevQ: Quat = IDENTITY_Q;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i]!;
      link.visible = alive && i < this.visibleCount;

      const pos = beltPos[i]!;
      link.position.set(prevPoint.x, prevPoint.y, prevPoint.z);

      const dir = sub(pos, prevPoint);
      const segLen = len(dir);
      let bendQ = prevQ;
      if (segLen > 1e-6) {
        const dirUnit = scale(dir, 1 / segLen);
        const localX = qRotate(prevQ, X_AXIS);
        bendQ = qMul(qFromUnitVectors(localX, dirUnit), prevQ);
      }

      const twistQ = qFromAxisAngle(X_AXIS, beltTwist[i]!);
      const q = qMul(bendQ, twistQ);
      link.quaternion.set(q.x, q.y, q.z, q.w);

      prevQ = bendQ;
      prevPoint = pos;
    }
  }

  collisionSections(dt: number, baseR: Vec3, baseV: Vec3, q: Quat): BeltSection[] {
    return this.physics.collisionSections(dt, baseR, baseV, q);
  }

  applyCollisionSections(dt: number, baseR: Vec3, baseV: Vec3, q: Quat): void {
    this.physics.applyCollisionSections(dt, baseR, baseV, q);
  }
}
