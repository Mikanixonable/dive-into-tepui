import * as THREE from 'three/webgpu';
import { sub, Vec3 } from '../../math/vec3';


// フローティングオリジン: 描画フレームの原点として毎フレーム取り直す、ECI 上の一点の運動状態。
// 倍精度の ECI 絶対座標を、この点からの相対へ写して単精度の GPU へ渡す。
//   r … 位置の基準。アクティブカメラの ECI 位置を渡す — カメラの位置成分がほぼ0でないと、
//       単精度で合成するビュー行列が桁落ちし、カメラが動くたびに描画対象が振動する。
//   v … 残像として描く物(弾)が差し引く速度の基準。カメラが注視している点の速度を渡す
//       (残像の向きは見る側との相対運動で決まる)。
export class FloatingOrigin {
  public readonly r: Vec3;
  private readonly v: Vec3;

  // r/v を今フレームの原点・速度基準として固定する。
  public constructor(r: Vec3, v: Vec3) {
    this.r = r;
    this.v = v;
  }

  // 慣性系(ECI)の絶対位置を、描画フレーム(原点 = r)の THREE.Vector3 へ変換する。
  public RtoThreeV3(vec: Vec3): THREE.Vector3 {
    const r2 = sub(vec, this.r);
    return new THREE.Vector3(r2.x, r2.y, r2.z);
  }

  // 慣性系の絶対速度を、描画フレーム(速度基準 = v)相対の THREE.Vector3 へ変換する。
  public VtoThreeV3(vec: Vec3): THREE.Vector3 {
    const v2 = sub(vec, this.v);
    return new THREE.Vector3(v2.x, v2.y, v2.z);
  }
}
