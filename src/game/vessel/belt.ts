// マガジンベルトの表示メッシュを管理する。物理演算結果から各リンクの位置・向きを導出してメッシュへ反映する。
import * as THREE from 'three/webgpu';
import { Attitude, Quat, qFromAxisAngle, qFromUnitVectors, qMul, qRotate } from '../../physics/attitude';
import { Vec3, len, scale, sub } from '../../physics/vec3';
import * as C from '../const';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH, buildMagazineMesh } from '../../render/ships';
import { BeltPhysics, BeltSection, X_AXIS } from './belt-physics';
import type { GameEntity } from '../game-entity/game-entity';

const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class Belt {
  private readonly links: THREE.Group[] = [];
  private readonly physics: BeltPhysics;
  private feed = 0;
  private visibleCount = 0;

  // リンクメッシュを renderObject の子として並べ、たわみ物理を初期化する。owner は接触判定で
  // 自身の節点との接触を除外するために使う吊り元の艦。
  public constructor(renderObject: THREE.Object3D, owner: GameEntity) {
    const group = new THREE.Group();
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = MAG_BELT_ANCHOR_X + (i + 0.5) * MAG_BELT_PITCH;
      group.add(link);
      this.links.push(link);
    }
    renderObject.add(group);
    this.physics = new BeltPhysics(this.links.length, owner);
  }

  // 見えているリンク数と給弾進み(beltFeed)を弾薬状態から導出し、たわみ物理を進める。
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

  // 物理演算で求めた各リンクの位置・向きをメッシュへ反映する。
  sync(): void {
    const { beltPos, beltTwist, anchor } = this.physics;
    let prevPoint = anchor;
    let prevQ: Quat = IDENTITY_Q;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i]!;
      link.visible = i < this.visibleCount;

      // 表示位置は前後端の中点
      const pos = beltPos[i]!;
      link.position.set((prevPoint.x + pos.x) / 2, (prevPoint.y + pos.y) / 2, (prevPoint.z + pos.z) / 2);

      // 前リンクの+Xから接線方向への回転で曲げ姿勢を求める
      const dir = sub(pos, prevPoint);
      const segLen = len(dir);
      let bendQ = prevQ;
      if (segLen > 1e-6) {
        const dirUnit = scale(dir, 1 / segLen);
        const localX = qRotate(prevQ, X_AXIS);
        bendQ = qMul(qFromUnitVectors(localX, dirUnit), prevQ);
      }

      // ロールを掛け合わせて最終姿勢にする
      const twistQ = qFromAxisAngle(X_AXIS, beltTwist[i]!);
      const q = qMul(bendQ, twistQ);
      link.quaternion.set(q.x, q.y, q.z, q.w);

      prevQ = bendQ;
      prevPoint = pos;
    }
  }

  // 各リンクの体軸座標を ECI 絶対状態に変換し、衝突判定用の BeltSection として返す。
  collisionSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): BeltSection[] {
    return this.physics.collisionSections(dt, baseR, baseV, att);
  }

  // 衝突解決後の ECI 状態を体軸座標へ戻し、たわみ物理へ反映する。
  applyCollisionSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    this.physics.applyCollisionSections(dt, baseR, baseV, att);
  }
}
