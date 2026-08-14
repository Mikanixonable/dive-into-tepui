// シーン照明を受ける不透明物(MeshStandardMaterial)の層。天体・線・ビルボードなど自照式の
// マテリアルは対象外 — G バッファパス(gbuffer.ts)とマテリアルパス(material-pass.ts)が
// この層だけを描く。
import * as THREE from 'three/webgpu';

// obj.layers の専用チャンネル。既定のチャンネル0からは外して(enable でなく set)このチャンネル
// だけへ移すので、world パス(既定のカメラマスク)はこのチャンネルだけのメッシュを描かない —
// マークされたオブジェクトは G バッファパスとマテリアルパスだけで描かれ、他のどのパスでも
// 描かれないというのが、このチャンネル分離が成り立たせる規則そのもの。
export const LIT_OPAQUE_LAYER = 1;

// root 以下を走査し、MeshStandardMaterial を持つ Mesh(マテリアル配列中の1つでも該当すれば)を
// チャンネル0から外して LIT_OPAQUE_LAYER だけへ置く。それ以外のマテリアルは無視するので、
// 組み立て済みのオブジェクトへ何度呼んでも、またどの段階で呼んでも安全。
export function markLitOpaque(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
    const isStandard = Array.isArray(material)
      ? material.some((m) => m.isMeshStandardMaterial)
      : material.isMeshStandardMaterial;
    if (isStandard) mesh.layers.set(LIT_OPAQUE_LAYER);
  });
}
