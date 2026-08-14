import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { KinematicState } from '../../physics/kinematic-state';
import { Attractor } from '../../physics/attractor';
import { containingBody } from '../../physics/sphere-contact';
import { isBurnedUp } from '../../physics/atmosphere';
import { FloatingOrigin } from '../floating-origin';
import type { Stage } from '../stages/stage';
import type { Contact } from '../simulation/contact';
import { Vec3, lenSq, sub } from '../../physics/vec3';
import * as C from '../const';
import { buildBulletMesh, buildPlasmaMesh } from '../../render/ships';
import { Enemy } from './enemy';
import { Player } from '../player/player';
import type { Sfx } from '../../audio/sfx';


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
    readonly damage: number;
    private passedClose: boolean = false; // 至近通過音を鳴らし終えたか
    private readonly lifetime: number;
    private readonly _sfx: Sfx;

    // accent: plasma 弾のみ使う発光色(未指定なら buildPlasmaMesh の既定色)。normal 弾では無視する。
    // damage は着弾時に与える HP。撃った側の武装で決まるので、弾自身が持ち歩く。
    constructor(state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number, sfx: Sfx, scene?: THREE.Scene) {
        // renderObject は InstancedPool へ渡す変換を保持する。
        super(state, type === 'plasma' ? buildPlasmaMesh() : buildBulletMesh(), scene, undefined, undefined, false);
        this.bornSim = state.t;
        this.lifetime = lifetime;
        this.shooter = shooter;
        this.type = type;
        this.damage = damage;
        this._sfx = sfx;
        this.mass = C.BULLET_MASS;
        this.radius = C.BULLET_RADIUS;
        this.collides = true;
    }

    // 弾同士は接触しない。敵弾は Enemy と接触しない(敵は同士討ちしない)。自陣営の艦とは
    // 発射後 SELF_CONTACT_GRACE の間だけ接触しない — 敵は同士討ちしないが自機は猶予を過ぎた
    // 自弾に当たる、という非対称は意図的(規則2・3は対称ではない)。艦に取り付いた実体
    // (ベルトの節点・放熱板の折り)は attachedTo を辿って艦本体と同じ扱いにする。
    contactsWith(other: GameEntity | Attractor, simTime: number): boolean {
        if (other instanceof Bullet) return false;
        const ship = other instanceof GameEntity ? other.attachedTo ?? other : other;
        if (this.shooter === 'enemy' && ship instanceof Enemy) return false;
        const ownShip = (this.shooter === 'player' && ship instanceof Player)
            || (this.shooter === 'enemy' && ship instanceof Enemy);
        if (ownShip && simTime - this.bornSim <= C.SELF_CONTACT_GRACE) return false;
        return true;
    }

    // 弾自身は接触したら消える。相手への作用は相手の collideWith が書く。
    collideWith(_other: GameEntity | Attractor, _contact: Contact): void {
        this.alive = false;
    }

    // 寿命切れの絶対時刻を返す。すでに過ぎていれば null。
    nextSimulationEventTime(simTime: number): number | null {
        const expiresAt = this.bornSim + this.lifetime;
        return expiresAt >= simTime ? expiresAt : null;
    }

    // 消滅条件は「自機から離れすぎた」が主で、寿命は保険。敵弾が自機の至近を通過した瞬間の
    // 判定もここで行う(substep ごとの位置だけを見る、意図的に雑な最接近判定)。
    checkLoss(_dt: number, simTime: number, _activeStage: Stage, playerPos: Vec3, attractors: readonly Attractor[]): void {
        if (!this.alive) return;
        if (this.shooter === 'enemy' && !this.passedClose
          && lenSq(sub(this.state.r, playerPos)) < C.BULLET_CLOSE_PASS_DIST * C.BULLET_CLOSE_PASS_DIST) {
            this.passedClose = true;
            if (this.type === 'plasma') this._sfx.magneticInterference();
        }
        // 至近通過音は消滅判定より先に評価する — 同じ substep で寿命が尽きる弾でも通過音は鳴らす。
        if (containingBody(this.state.r, attractors, 0) !== null
          || isBurnedUp(this.state.r, attractors, C.DEBRIS_REENTRY_ALT)) { this.alive = false; return; }
        if (lenSq(sub(this.state.r, playerPos)) > C.BULLET_MAX_DIST * C.BULLET_MAX_DIST) { this.alive = false; return; }
        if (simTime - this.bornSim >= this.lifetime) this.alive = false;
    }

    // 姿勢を持たないため、att.q ではなくフローティングオリジンに対する相対速度方向を向く。
    sync(fo: FloatingOrigin, displayTime: number): void {
        // 表示できる時刻の範囲外なら非表示にする
        const s = this.displayState(displayTime);
        if (s === null) {
            this.renderObject.visible = false;
            return;
        }
        this.renderObject.visible = true;
        this.renderObject.position.copy(fo.RtoThreeV3(s.r));
        // 相対速度方向へ機体を向ける
        const relVel = fo.VtoThreeV3(s.v);
        if (relVel.lengthSq() <= 1e-6) return;
        tmpQuat.setFromUnitVectors(zAxis, relVel.normalize());
        this.renderObject.quaternion.copy(tmpQuat);
    }
}
