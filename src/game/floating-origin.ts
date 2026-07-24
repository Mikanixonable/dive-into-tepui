import * as THREE from 'three';
import { sub, Vec3 } from '../physics/vec3';


// THREE.jsのVectorオブジェクトは一貫してfloating origin補正後のものを表し、
// 独自定義のVec3は地球座標系を表す。この変換はFloatingOriginを必ず経由する。

// フローティングオリジン: 描画のたびに原点として取り直す、慣性系(ECI)上の一点の運動状態。
// 論理計算は倍精度の絶対座標(ECI)で行い、描画の直前にこの一点を原点へ平行移動して
// 単精度 GPU が LEO 級の絶対値を扱わずに済むようにする。
//   r … 平行移動の基準。全メッシュ・カメラを「絶対座標 - r」に置く。
//   v … 相対速度で向きを決める描画(弾・リードマーカー等)が差し引く速度基準。
// 現時点では自機の運動状態(player.state)を使うが、それとは意味論的に別物として扱う —
// 将来カメラ等を原点に切り替えても描画上の相対位置が保たれるよう、sync 系はこの一点
// だけを参照し、個々のモジュールは player.state.r を原点として直接参照しない。
export class FloatingOrigin {
  private readonly  r: Vec3;
  private readonly v: Vec3;

  constructor(r: Vec3, v: Vec3) {
    this.r = r;
    this.v = v;
  }

  // 慣性系(ECI)の絶対位置を、描画フレーム(原点 = r)の THREE.Vector3 へ変換する。
  // 論理(Vec3)と描画(THREE.Vector3)の唯一の橋渡し — fo 由来の位置変換は必ずここを通す。
  RtoThreeV3(vec: Vec3): THREE.Vector3 {
    const r2 = sub(vec, this.r);
    return new THREE.Vector3(r2.x, r2.y, r2.z);
  }

  // 慣性系の絶対速度を、描画フレーム(速度基準 = v)相対の THREE.Vector3 へ変換する。
  // 相対速度で向きを決める描画(弾のモーションブラー等)専用。位置の toThreeVector3 と対称。
  VtoThreeV3(vec: Vec3): THREE.Vector3 {
    const v2 = sub(vec, this.v);
    return new THREE.Vector3(v2.x, v2.y, v2.z);
  }
}
