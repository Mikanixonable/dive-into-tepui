// 雲場と積雲表現が共有する定数・空field契約。coverage、雲頂、粒、光学的厚みのGPU式は
// CloudShapeEvaluatorへ、UVとLODを含むテクスチャ読みはCloudFieldSamplerへ置く。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { FloatUniform } from '../tsl-types';

// 雲のアルベド。厚い雲の白さは多重散乱の産物で、単散乱アルベド ≈ 1・光学的厚みが十分に大きい
// 層の反射は拡散反射の極限へ漸近する。
export const CLOUD_ALBEDO = 0.8;

// 場を持たない天体のスロットへ結ぶ、被覆率 0 の写し。**読み方の契約は本物の場と揃える** —
// シェーダグラフはここに結んだテクスチャのフィルタと巻きから組まれるので、既定の Nearest の
// ままだと補間の無い texel フェッチが焼き込まれ、あとで本物へ差し替えても格子が出たままになる。
export const EMPTY_CLOUD_FIELD = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
EMPTY_CLOUD_FIELD.minFilter = THREE.LinearMipmapLinearFilter;
EMPTY_CLOUD_FIELD.magFilter = THREE.LinearFilter;
EMPTY_CLOUD_FIELD.wrapS = THREE.RepeatWrapping;
EMPTY_CLOUD_FIELD.needsUpdate = true;

// 場の G(雲頂高度)を実寸へ戻す上限 [m]。場の G 自体は 0..1 で持つ。
export const CLOUD_TOP_SPAN = 15000;

// 被覆率を不透明な雲頂へ渡す境目(center)と、その前後で連続に渡す半幅(halfWidth)。被覆率が
// center±halfWidth に入る柱だけが 0..1 の中間値になり、外は 0 か 1 へ飽和する。どちらも目で
// 追い込んだ値で、場を差し替えたら追い込み直す。
//
// **仮設**: render-lab のつまみ(tools/render-lab/main.ts)から動かせるよう uniform にしてある。
// 生成側の場へ差し替えたあとにもう一段の追い込みが要るので、それまでは畳まない。
export const CUMULUS_COVERAGE_KNOB: {
  readonly center: FloatUniform;
  readonly halfWidth: FloatUniform;
} = { center: uniform(0.34), halfWidth: uniform(0.12) };

// 積雲の粒の一辺 [m]。場の texel(赤道 9.8 km)より細かく、かつ低軌道から見下ろして解像できる
// 大きさ(高度 900km 以下で全振幅)に取る。これより細かくすると、実際の積雲の塊には近づく代わりに
// 軌道上のどの構図でも 1 画素を切って消える。
export const CUMULUS_GRAIN_SIZE = 6000;
