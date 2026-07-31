import * as THREE from 'three/webgpu';
import { OrbitEntity } from './entities';
import { OrbitState } from '../../physics/orbital';
import { FloatingOrigin } from '../floating-origin';
import type { Stage } from '../stages/stage';
import { altitudeOf } from '../../physics/orbital';
import { Vec3, lenSq, sub } from '../../physics/vec3';
import * as C from '../const';
import { buildBulletMesh, buildPlasmaMesh } from '../../render/ships';


const tmpQuat = new THREE.Quaternion();
const zAxis = new THREE.Vector3(0, 0, 1);

// 弾を撃った主体
export type Shooter = 'player' | 'enemy';

// 自弾(normal)と敵プラズマ弾(plasma)を区別する種別。見た目・命中対象のルールが
// type によって分岐する(hit.ts/player.ts/enemy.ts 参照)。
export type BulletType = 'normal' | 'plasma';

// 自弾と敵プラズマ弾の両方に使う。Simulator.bullets という単一配列に保持され、
// 命中ルール(hit.ts)は各弾が持つ type/shooter を見て分岐する。寿命(lifetime)は
// 生成時に渡された値を自身で持つ。
// dispose() は基底の OrbitEntity.dispose()(scene.remove のみ)をそのまま使う。
// buildBulletMesh/buildPlasmaMesh(render/ships.ts)のハロー用 geometry/material は
// モジュールスコープ(通常弾)または accent 値ごと(プラズマ弾。取りうる値は少数)に
// キャッシュされた共有インスタンスであり、本体側も memoParseShared() 由来で
// geometry/material を参照共有している(発射後に個体ごとの色/不透明度変更は行わない)。
// つまり Bullet.obj 配下に「この弾だけが所有する」GPU リソースは存在しないため、
// traverse して dispose するとまだ生きている他の弾から共有リソースを奪ってしまう
// (BUG_REPORT.md B1 参照)。
export class Bullet extends OrbitEntity {
    // 弾は移動が速く、線分衝突判定(hit.ts)・標的面通過判定(targeter.ts)が直前サブステップ位置を
    // 読むので 1 件だけ保持する。
    protected readonly historyLength = 1;

    readonly bornSim: number; // 発射時刻。初期 state のエポックそのもの
    readonly shooter: Shooter;
    readonly type: BulletType;
    private readonly lifetime: number;

    // accent: plasma 弾のみ使う発光色(未指定なら buildPlasmaMesh の既定色)。normal 弾では無視する。
    constructor(state: OrbitState, lifetime: number, shooter: Shooter, type: BulletType, scene?: THREE.Scene, accent?: number) {
        super(state, type === 'plasma' ? buildPlasmaMesh(accent) : buildBulletMesh(), scene);
        this.bornSim = state.t;
        this.lifetime = lifetime;
        this.shooter = shooter;
        this.type = type;
    }

    // 消滅条件は「自機から離れすぎた」が主で、寿命は保険(const.ts の BULLET_MAX_DIST 参照)。
    // 自機位置を受け取るのはこの派生だけだが、基底の checkLoss で一律に渡している。
    checkLoss(_dt: number, simTime: number, _activeStage: Stage, playerPos: Vec3): void {
        if (!this.alive) return;
        if (altitudeOf(this.state.r) < C.DEBRIS_REENTRY_ALT) { this.alive = false; return; }
        if (lenSq(sub(this.state.r, playerPos)) > C.BULLET_MAX_DIST * C.BULLET_MAX_DIST) { this.alive = false; return; }
        if (simTime - this.bornSim > this.lifetime) this.alive = false;
    }

    // 姿勢を持たないため、att.q ではなくフローティングオリジンに対する相対速度方向を
    // 向く(モーションブラー的表現)。位置は toThreeVector3(r 差引)、向きは toThreeVelocity
    // (v 差引)で描画フレームへ変換する
    sync(fo: FloatingOrigin): void {
        this.obj.position.copy(fo.RtoThreeV3(this.state.r));
        const relVel = fo.VtoThreeV3(this.state.v);
        if (relVel.lengthSq() <= 1e-6) return;
        tmpQuat.setFromUnitVectors(zAxis, relVel.normalize());
        this.obj.quaternion.copy(tmpQuat);
    }
}