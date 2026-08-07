import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { OrbitState, altitudeOf } from '../../physics/orbital-state';
import { FloatingOrigin } from '../floating-origin';
import type { Stage } from '../stages/stage';
import { Vec3, lenSq, sub } from '../../physics/vec3';
import * as C from '../const';
import { buildBulletMesh, buildPlasmaMesh } from '../../render/ships';


const tmpQuat = new THREE.Quaternion();
const zAxis = new THREE.Vector3(0, 0, 1);

// 弾を撃った主体
export type Shooter = 'player' | 'enemy';

// 自弾(normal)と敵プラズマ弾(plasma)を区別する種別。
export type BulletType = 'normal' | 'plasma';

// 自弾と敵プラズマ弾の両方に使う。
// geometry/material はビルダーが弾種ごとに共有するため、traverse による個別 dispose は行わない。
export class Bullet extends GameEntity {
    protected readonly bcInv = C.BULLET_BCINV;

    readonly bornSim: number; // 発射時刻。初期 state のエポックそのもの
    readonly shooter: Shooter;
    readonly type: BulletType;
    passedClose: boolean = false; // 至近を通過したかどうかのフラグ
    private readonly lifetime: number;

    // accent: plasma 弾のみ使う発光色(未指定なら buildPlasmaMesh の既定色)。normal 弾では無視する。
    constructor(state: OrbitState, lifetime: number, shooter: Shooter, type: BulletType, scene?: THREE.Scene) {
        super(state, type === 'plasma' ? buildPlasmaMesh() : buildBulletMesh(), scene);
        this.bornSim = state.t;
        this.lifetime = lifetime;
        this.shooter = shooter;
        this.type = type;
    }

    nextSimulationEventTime(simTime: number): number | null {
        const expiresAt = this.bornSim + this.lifetime;
        return expiresAt >= simTime ? expiresAt : null;
    }

    // 消滅条件は「自機から離れすぎた」が主で、寿命は保険。
    checkLoss(_dt: number, simTime: number, _activeStage: Stage, playerPos: Vec3): void {
        if (!this.alive) return;
        if (altitudeOf(this.state.r) < C.DEBRIS_REENTRY_ALT) { this.alive = false; return; }
        if (lenSq(sub(this.state.r, playerPos)) > C.BULLET_MAX_DIST * C.BULLET_MAX_DIST) { this.alive = false; return; }
        if (simTime - this.bornSim >= this.lifetime) this.alive = false;
    }

    // 姿勢を持たないため、att.q ではなくフローティングオリジンに対する相対速度方向を向く。
    sync(fo: FloatingOrigin, displayTime: number): void {
        // 表示できる時刻の範囲外なら非表示にする
        const s = this.displayState(displayTime);
        if (s === null) {
            this.obj.visible = false;
            return;
        }
        this.obj.visible = true;
        this.obj.position.copy(fo.RtoThreeV3(s.r));
        // 相対速度方向へ機体を向ける
        const relVel = fo.VtoThreeV3(s.v);
        if (relVel.lengthSq() <= 1e-6) return;
        tmpQuat.setFromUnitVectors(zAxis, relVel.normalize());
        this.obj.quaternion.copy(tmpQuat);
    }
}
