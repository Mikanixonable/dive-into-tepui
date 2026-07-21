// マガジンベルトの表示メッシュ(機体への追加、各リンクの Group)と、給弾の
// 進み(beltFeed)に伴う毎フレーム更新の責務。たわみ・ねじれの物理演算そのものは
// belt-physics.ts の BeltPhysics に委譲する(このファイルは物理を持たない)。
import * as THREE from 'three/webgpu';
import { Attitude, Quat } from '../../physics/attitude';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { MAG_BELT_PITCH, buildMagazineMesh } from '../../render/ships';
import { BeltSection } from '../orbit-entity/entities';
import { BeltPhysics } from './belt-physics';

export class Belt {
  private readonly links: THREE.Group[] = [];
  private readonly physics: BeltPhysics;
  private feed = 0;

  constructor(playerObj: THREE.Object3D) {
    const group = new THREE.Group();
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = 0.9 + i * MAG_BELT_PITCH;
      group.add(link);
      this.links.push(link);
    }
    playerObj.add(group);
    this.physics = new BeltPhysics(this.links);
  }

  // 見えているリンク数と、たわみアンカーの給弾進み(beltFeed)を弾薬状態から
  // 導出し、たわみ物理(BeltPhysics)を進めて表示メッシュへ反映する。
  update(
    dt: number,
    magsLeft: number,
    roundsInMag: number,
    att: Attitude,
    thrustAccelVec: Vec3,
    alive: boolean,
  ): void {
    const count = Math.min(magsLeft, C.BELT_MAX_VISIBLE);
    const targetFeed = 1 - roundsInMag / C.MAG_ROUNDS;
    if (targetFeed < this.feed - 0.5) {
      this.physics.shiftBeltNodes();
      this.feed = targetFeed;
    } else {
      this.feed += (targetFeed - this.feed) * Math.min(1, dt * 12);
    }
    this.physics.updateBeltPhysics(dt, count, att, thrustAccelVec, this.feed, alive);
  }

  collisionSections(dt: number, baseR: Vec3, baseV: Vec3, q: Quat): BeltSection[] {
    return this.physics.collisionSections(dt, baseR, baseV, q);
  }

  applyCollisionSections(dt: number, baseR: Vec3, baseV: Vec3, q: Quat): void {
    this.physics.applyCollisionSections(dt, baseR, baseV, q);
  }
}
