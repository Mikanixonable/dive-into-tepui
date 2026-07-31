import * as THREE from 'three';
import { sub, Vec3 } from '../physics/vec3';


// フローティングオリジン: 描画のたびに原点として取り直す、慣性系(ECI)上の一点の運動状態。
// 論理計算は倍精度の絶対座標(ECI)で行い、描画の直前にこの一点を原点へ平行移動して
// 単精度 GPU が LEO 級の絶対値を扱わずに済むようにする。
//   r … 平行移動の基準。全メッシュ・カメラを「絶対座標 - r」に置く。
//   v … 相対速度で向きを決める描画(弾・リードマーカー等)が差し引く速度基準。
export class FloatingOrigin {
  private readonly  r: Vec3;
  private readonly v: Vec3;

  // r/v を今フレームの原点・速度基準として固定する。
  constructor(r: Vec3, v: Vec3) {
    this.r = r;
    this.v = v;
  }

  // 慣性系(ECI)の絶対位置を、描画フレーム(原点 = r)の THREE.Vector3 へ変換する。
  RtoThreeV3(vec: Vec3): THREE.Vector3 {
    const r2 = sub(vec, this.r);
    return new THREE.Vector3(r2.x, r2.y, r2.z);
  }

  // 慣性系の絶対速度を、描画フレーム(速度基準 = v)相対の THREE.Vector3 へ変換する。
  // 相対速度で向きを決める描画(弾のモーションブラー的表現等)に使う。
  VtoThreeV3(vec: Vec3): THREE.Vector3 {
    const v2 = sub(vec, this.v);
    return new THREE.Vector3(v2.x, v2.y, v2.z);
  }
}
