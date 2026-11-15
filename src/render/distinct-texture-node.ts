// 同じテクスチャを指していても、別々の結びのままでいるテクスチャノード。
import * as THREE from 'three/webgpu';
import { nodeObject } from 'three/tsl';

// three.js は、シェーダを組む時点で uuid の同じテクスチャを指すテクスチャノードを 1 つの結びへ合わせる
// (TextureNode.getUniformHash が value.uuid を返す)。あとから .value を別のテクスチャへ差し替えても結びは
// 1 つのままで、合わさったノードは全部、先に使われた 1 つのノードの値を読む。**シェーダを、値を結ぶ前に組む
// とき**(ゲームは起動時に先に組む)や、2 つのノードが同じテクスチャを持つ瞬間に組み直すときに踏む。
// 結びの hash を、値のテクスチャではなく基底ノード自身の uuid にして防ぐ。sample() が返すノードは基底の
// 複製で、new this.constructor で作られるので、サブクラスなら複製へも効く(インスタンスへの代入は効かない)。
class DistinctTextureNode extends THREE.TextureNode {
  public override getUniformHash(): string { return this.getBase().uuid; }
}

// 差し替える前提で、いまは initial(空の写し)を指させるテクスチャノード。
export function distinctTextureNode(initial: THREE.Texture): THREE.TextureNode {
  return nodeObject(new DistinctTextureNode(initial)) as unknown as THREE.TextureNode;
}
