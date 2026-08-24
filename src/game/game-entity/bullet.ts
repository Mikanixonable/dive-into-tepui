import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { KinematicState } from '../../physics/kinematic-state';
import { CelestialBody } from '../../physics/celestial-body';

import { FloatingOrigin } from '../floating-origin';
import type { Stage } from '../stages/stage';
import type { Contact } from './contact';
import { Vec3, lenSq, sub } from '../../physics/vec3';
import * as C from '../const';
import { buildBulletMesh, buildPlasmaMesh } from '../../render/ships';
import { orientProjectile } from '../../render/projectile-orientation';
import { Enemy } from './enemy';
import { Player } from '../player/player';
import type { WorldSfx } from '../../audio/sfx/world-sfx';


const tmpQuat = new THREE.Quaternion();

// 弾を撃った主体
export type Shooter = 'player' | 'enemy';

// 自弾(normal)と敵プラズマ弾(plasma)を区別する種別。
export type BulletType = 'normal' | 'plasma';

// 自弾と敵プラズマ弾の両方に使う。
// geometry/material はビルダーが弾種ごとに共有するため、traverse による個別 dispose は行わない。
export class Bullet extends GameEntity {
    override readonly bcInv = C.BULLET_BCINV;
    // 弾は姿勢を持たず、速度方向を向く(sync)。
    readonly hasAttitude = false;

    readonly bornSim: number; // 発射時刻。初期 state のエポックそのもの
    readonly shooter: Shooter;
    readonly type: BulletType;
    readonly damage: number;
    private passedClose: boolean = false; // 至近通過音を鳴らし終えたか
    private readonly lifetime: number;
    private readonly _worldSfx: WorldSfx;
    // The direction shown by a projectile is relative to its shooter, not to the
    // floating-origin velocity (which is usually the player's velocity). Keeping
    // the reference entity lets a moving enemy's plasma point along its actual
    // launch direction instead of appearing to slide sideways.
    private readonly velocityReference: GameEntity | null;

    // accent: plasma 弾のみ使う発光色(未指定なら buildPlasmaMesh の既定色)。normal 弾では無視する。
    // damage は着弾時に与える HP。撃った側の武装で決まるので、弾自身が持ち歩く。
    constructor(
        state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number,
        worldSfx: WorldSfx, scene?: THREE.Scene, velocityReference?: GameEntity,
    ) {
        // renderObject は InstancedPool へ渡す変換を保持する。
        super(state, type === 'plasma' ? buildPlasmaMesh() : buildBulletMesh(), scene, undefined, undefined, false);
        this.bornSim = state.t;
        this.lifetime = lifetime;
        this.shooter = shooter;
        this.type = type;
        this.damage = damage;
        this._worldSfx = worldSfx;
        this.velocityReference = velocityReference ?? null;
        this.mass = C.BULLET_MASS;
        this.radius = C.BULLET_RADIUS;
        this.collides = true;
    }

    // 弾同士は接触しない。敵弾は Enemy と接触しない(敵は同士討ちしない)。自陣営の艦とは
    // 発射後 SELF_CONTACT_GRACE の間だけ接触しない — 敵は同士討ちしないが自機は猶予を過ぎた
    // 自弾に当たる、という非対称は意図的(規則2・3は対称ではない)。艦に取り付いた実体
    // (ベルトの節点・放熱板の折り)は attachedTo を辿って艦本体と同じ扱いにする。
    contactsWith(other: GameEntity, simTime: number): boolean {
        if (other instanceof Bullet) return false;
        const ship = other.attachedTo ?? other;
        if (this.shooter === 'enemy' && ship instanceof Enemy) return false;
        const ownShip = (this.shooter === 'player' && ship instanceof Player)
            || (this.shooter === 'enemy' && ship instanceof Enemy);
        if (ownShip && simTime - this.bornSim <= C.SELF_CONTACT_GRACE) return false;
        return true;
    }

    // 弾自身は接触したら消える。相手への作用は相手の collideWithEntity が書く。
    collideWithEntity(_other: GameEntity, _contact: Contact): void {
        this.alive = false;
    }

    // 寿命切れの絶対時刻を返す。すでに過ぎていれば null。
    nextSimulationEventTime(simTime: number): number | null {
        const expiresAt = this.bornSim + this.lifetime;
        return expiresAt >= simTime ? expiresAt : null;
    }

    // 消滅条件は「自機から離れすぎた」が主で、寿命は保険。敵弾が自機の至近を通過した瞬間の
    // 判定もここで行う(substep ごとの位置だけを見る、意図的に雑な最接近判定)。
    checkLoss(
        _dt: number, simTime: number, _activeStage: Stage, playerPos: Vec3,
        _atmosphereBodies: readonly CelestialBody[],
    ): void {
        if (!this.alive) return;
        if (this.shooter === 'enemy' && !this.passedClose
          && lenSq(sub(this.state.r, playerPos)) < C.BULLET_CLOSE_PASS_DIST * C.BULLET_CLOSE_PASS_DIST) {
            this.passedClose = true;
            if (this.type === 'plasma') this._worldSfx.magneticInterference();
        }
        // 至近通過音は消滅判定より先に評価する — 同じ substep で寿命が尽きる弾でも通過音は鳴らす。
        if (lenSq(sub(this.state.r, playerPos)) > C.BULLET_MAX_DIST * C.BULLET_MAX_DIST) { this.alive = false; return; }
        if (simTime - this.bornSim >= this.lifetime) this.alive = false;
    }

    // 姿勢を持たないため、att.q ではなく射手に対する相対速度方向を向く。
    sync(fo: FloatingOrigin, displayTime: number): void {
        // 表示できる時刻の範囲外なら非表示にする
        const s = this.displayState(displayTime);
        if (s === null) {
            this.renderObject.visible = false;
            return;
        }
        this.renderObject.visible = true;
        this.renderObject.position.copy(fo.RtoThreeV3(s.r));
        // 射手の表示時刻の速度を差し引く。射手が無い旧来の呼び出しだけは
        // FloatingOrigin の速度基準へフォールバックする。
        const reference = this.velocityReference?.displayState(displayTime);
        const relative = reference === null || reference === undefined ? null : sub(s.v, reference.v);
        const relVel = relative === null
            ? fo.VtoThreeV3(s.v)
            : new THREE.Vector3(relative.x, relative.y, relative.z);
        if (!orientProjectile(tmpQuat, relVel)) return;
        this.renderObject.quaternion.copy(tmpQuat);
    }
}
