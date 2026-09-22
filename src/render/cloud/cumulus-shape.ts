// 雲場と積雲表現が共有する定数と、雲場未設定の天体へ割り当てる空のダミーテクスチャ。被覆率・雲頂・粒・光学的厚みの
// GPU 式は CloudShapeEvaluator へ、雲場の uv でのテクスチャ読みは CloudFieldSampler へ置く。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { CLOUD_MODEL_PARAMETERS } from './cloud-model-parameters';
import type { FloatUniform } from '../tsl-types';

// 雲のアルベド。厚い雲の白さは多重散乱の産物で、単散乱アルベド ≈ 1・光学的厚みが十分に大きい
// 層の反射は拡散反射の極限へ漸近する。
export const CLOUD_ALBEDO = 0.8;

// 雲場未設定の天体スロットへ割り当てる、被覆率 0 のテクスチャ。**サンプリング仕様を実フィールドと統一する** —
// シェーダグラフはここに結んだテクスチャのフィルタと巻きから組まれるので、既定の Nearest の
// ままだと補間の無い texel フェッチが焼き込まれ、あとで本物へ差し替えても格子が出たままになる。
export const EMPTY_CLOUD_FIELD = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
EMPTY_CLOUD_FIELD.minFilter = THREE.LinearFilter;
EMPTY_CLOUD_FIELD.magFilter = THREE.LinearFilter;
EMPTY_CLOUD_FIELD.wrapS = THREE.RepeatWrapping;
EMPTY_CLOUD_FIELD.needsUpdate = true;

// 雲場から導出する雲頂高度の表示上限 [m]。RGBA は雲頂そのものではなく basis 係数を持つ。
// 低層・中層・対流上層・in-situ 上層の profile と同じ上端を使い、surface / atmosphere / shadow
// の support をずらさない。
export const CLOUD_TOP_SPAN = CLOUD_MODEL_PARAMETERS.maximumCloudAltitudeMeters;

// 被覆率を二値化する境目(center)と、その前後でディザへ渡す半幅(halfWidth)。被覆率が
// center±halfWidth に入る柱だけがディザに掛かり、外は 0 か 1 へ飽和する。どちらも目で追い込んだ
// 値で、場を差し替えたら追い込み直す。
//
// **開発用パラメータ**: render-lab のUIスライダー(tools/render-lab/main.ts)から調整できるよう uniform として定義されている。
// 生成側の雲場への置換後に最終調整が必要となるため、それまでは定数化しない。
export const CUMULUS_DITHER_KNOB: {
  readonly center: FloatUniform;
  readonly halfWidth: FloatUniform;
} = { center: uniform(0.34), halfWidth: uniform(0.12) };

// 積雲の粒の一辺 [m]。場の texel(全球正距円筒の赤道付近で約 12 km)より
// 細かく、かつ低軌道から見下ろして解像できる大きさ(高度 900km 以下で全振幅)に取る。これより
// 細かくすると、実際の積雲の塊には近づく代わりに軌道上のどの構図でも 1 画素を切って消える。
export const CUMULUS_GRAIN_SIZE = 6000;
