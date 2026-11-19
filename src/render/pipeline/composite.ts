// 合成段の共有部品。HDR の絵を表示値へ写す変換(トーンマッピングとフィルム風ルック)と、
// 色と G バッファ深度を載せる合成板マテリアルの共通の器。
import * as THREE from 'three/webgpu';
import { colorSpaceToWorking, neutralToneMapping, screenUV, texture, vec3, workingToColorSpace } from 'three/tsl';
import type { Exposure } from './exposure';
import type { FilmLut } from './film-lut';
import type { GBufferPass } from './gbuffer';
import type { Vec3Node, Vec4Node } from '../tsl-types';

// 1 を超える HDR 値を切り落とさず白へ寄せる。Khronos PBR Neutral を選ぶのは、圧縮開始点より
// 下では色相・彩度を保ったまま素通しするため — 「表示値 = アルベド」という校正が中間調では
// そのまま読み取れる。
export function toneMapped(color: Vec3Node, exposure: Exposure): Vec3Node {
  return neutralToneMapping(color, exposure.factor) as Vec3Node;
}

// フィルムのルックを、トーンマップ後の線形の色へ掛ける。ルックは表示値(sRGB 符号化済み)を
// 受けて表示値を返すので、掛ける前に符号化し、掛けたあとに線形へ戻す。画面への書き出しで
// レンダラがもう一度符号化するため、戻さなければ二重に符号化される。
export function filmLooked(color: Vec3Node, filmLut: FilmLut): Vec3Node {
  const encoded = workingToColorSpace(color, THREE.SRGBColorSpace) as unknown as Vec3Node;
  const graded = filmLut.apply(encoded);
  // ColorSpaceNode は vec4 型を名乗る — vec3 へ切り詰めないと vec4(filmLooked(...), 1) が
  // 成分数超過でエラーになり、末尾の 1 が黙って捨てられる。
  return vec3(colorSpaceToWorking(graded, THREE.SRGBColorSpace) as unknown as Vec3Node);
}

// 合成板マテリアルの共通の器。colorNode だけが表示ごとに異なる。深度は G バッファのものを描画先の
// 深度バッファへ複製する(depthTest を切ったまま depthWrite を立てるので全画素が無条件に書かれる)
// — 後続の 3D UI パスがこの深度に対してテストを行う。
export function buildCompositeMaterial(gbuffer: GBufferPass, colorNode: Vec4Node): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: true, transparent: false });
  material.colorNode = colorNode;
  material.depthNode = texture(gbuffer.depthTexture, screenUV).r;
  return material;
}
