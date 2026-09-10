import * as THREE from 'three/webgpu';
import { sub, Vec3 } from '../../math/vec3';


// フローティングオリジン: 描画のたびに原点として取り直す、慣性系(ECI)上の一点の運動状態。
// 論理計算は倍精度の絶対座標(ECI)で行い、描画の直前にこの一点を原点へ平行移動して
// 単精度 GPU が絶対値を扱わずに済むようにする。
//   r … 平行移動の基準。全メッシュ・カメラを「絶対座標 - r」に置く。アクティブカメラの
//       ECI 位置そのものを使う — カメラ自身の位置成分をほぼ0にしておかないと、WebGPU が
//       modelViewMatrix をシェーダ内で cameraViewMatrix * modelWorldMatrix として単精度合成する
//       際、絶対座標どうしの引き算がマップビューの天文単位スケールで f32 の丸め誤差(桁落ち)を
//       起こし、カメラが動くたびに丸め先が飛んで描画対象が振動して見える。原点をカメラに
//       揃えれば、残る誤差は「原点からの距離 × f32相対精度」で頭打ちになり、距離によらず
//       常にサブピクセルに収まる。
//   v … 残像として描かれる物(弾)が差し引く速度基準。r とは別の concern であり、カメラが
//       注視している点の速度を使う — 見る側に対する相対運動が残像の向きを決める。
export class FloatingOrigin {
  readonly r: Vec3;
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
  VtoThreeV3(vec: Vec3): THREE.Vector3 {
    const v2 = sub(vec, this.v);
    return new THREE.Vector3(v2.x, v2.y, v2.z);
  }
}
