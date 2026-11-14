// 同じテクスチャを指していても、別々の結びのままでいるテクスチャノード。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';

// three.js は、シェーダを組む時点で uuid の同じテクスチャを指すテクスチャノードを 1 つの結びへ合わせる
// (TextureNode.getUniformHash が value.uuid を返す)。あとから .value を別のテクスチャへ差し替えても結びは
// 1 つのままで、合わさったノードは全部、先に使われた 1 つのノードの値を読む。**シェーダを、値を結ぶ前に組む
// とき**(ゲームは起動時に先に組む)や、2 つのノードが同じテクスチャを持つ瞬間に組み直すときに踏む。
// ノードごとに結びを固定して防ぐ。差し替える前提で、いまは空の写しを指させるノードに使う。
export function distinctTextureNode(initial: THREE.Texture): THREE.TextureNode {
  const node = texture(initial);
  node.getUniformHash = () => node.uuid;
  return node;
}
