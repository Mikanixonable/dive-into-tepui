import * as THREE from 'three/webgpu';
import { OrbitEntity } from './entities';
import { OrbitState } from '../../physics/orbital';
import { Vec3 } from '../../physics/vec3';
import type { Stage } from '../stages/stage';
import { altitudeOf } from '../../physics/orbital';
import * as C from '../const';
import { buildBulletMesh, buildPlasmaMesh } from '../../render/ships';


const tmpVel = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const zAxis = new THREE.Vector3(0, 0, 1);

// 弾を撃った主体
export type Shooter = 'player' | 'enemy';

// 自弾(normal)と敵プラズマ弾(plasma)を区別する種別。見た目・命中対象のルールが
// type によって分岐する(hit.ts/player.ts/enemy.ts 参照)。
export type BulletType = 'normal' | 'plasma';

// 自弾と敵プラズマ弾の両方に使う。配列は射手(自機/敵)ごとに分けて保持し、
// 命中ルールは配列単位で扱うが、寿命(lifetime)は生成時に渡された値を自身で持つ。
export class Bullet extends OrbitEntity {
    bornSim: number;
    readonly shooter: Shooter;
    readonly type: BulletType;
    private readonly lifetime: number;

    // accent: plasma 弾のみ使う発光色(未指定なら buildPlasmaMesh の既定色)。normal 弾では無視する。
    constructor(state: OrbitState, bornSim: number, lifetime: number, shooter: Shooter, type: BulletType, scene?: THREE.Scene, accent?: number) {
        super(state, type === 'plasma' ? buildPlasmaMesh(accent) : buildBulletMesh(), scene);
        this.bornSim = bornSim;
        this.lifetime = lifetime;
        this.shooter = shooter;
        this.type = type;
    }

    checkLoss(_dt: number, simTime: number, _activeStage: Stage): void {
        if (!this.alive) return;
        if (altitudeOf(this.state.r) < C.DEBRIS_REENTRY_ALT) { this.alive = false; return; }
        if (simTime - this.bornSim > this.lifetime) this.alive = false;
    }

    // 姿勢を持たないため、att.q ではなく自機に対する相対速度方向を向く
    // (OrbitEntity.syncTransform とはシグネチャが異なるため、別名の独自メソッドにする)。
    syncBulletTransform(origin: Vec3, playerVelocity: Vec3): void {
        this.obj.position.set(this.state.r.x - origin.x, this.state.r.y - origin.y, this.state.r.z - origin.z);
        tmpVel.set(
            this.state.v.x - playerVelocity.x,
            this.state.v.y - playerVelocity.y,
            this.state.v.z - playerVelocity.z,
        );
        if (tmpVel.lengthSq() <= 1e-6) return;
        tmpQuat.setFromUnitVectors(zAxis, tmpVel.normalize());
        this.obj.quaternion.copy(tmpQuat);
    }
}