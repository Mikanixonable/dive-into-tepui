// シーン照明を受ける不透明物(MeshStandardMaterial)の層。天体・線・ビルボードなど自照式の
// マテリアルは対象外 — G バッファパス(gbuffer.ts)とマテリアルパス(material-pass.ts)が
// この層だけを描く。
import * as THREE from 'three/webgpu';

// obj.layers の専用チャンネル。既定のチャンネル0からは外して(enable でなく set)このチャンネル
// だけへ移すので、world パス(既定のカメラマスク)はこのチャンネルだけのメッシュを描かない —
// マークされたオブジェクトは G バッファパスとマテリアルパスだけで描かれ、他のどのパスでも
// 描かれないというのが、このチャンネル分離が成り立たせる規則そのもの。
export const LIT_OPAQUE_LAYER = 1;
// 星空のように自照式で、world パスより前に描く背景専用チャンネル。LIT_OPAQUE_LAYER と
// 同じカメラで描くことで、renderOrder(-10)を使って不透明物より先に色を書ける。world パスの
// 既定チャンネルには置かないので、後段の world 描画で星空が不透明物を上書きすることもない。
export const WORLD_BACKGROUND_LAYER = 2;

// マテリアルパスが見るチャンネル。シーンルートは全チャンネルを持つ必要があるため、呼び出し側は
// このマスクを設定する前に scene.layers.enableAll() を済ませておく。
export function setOpaquePassLayers(camera: THREE.Camera): void {
  camera.layers.set(LIT_OPAQUE_LAYER);
  camera.layers.enable(WORLD_BACKGROUND_LAYER);
}

// 標準マテリアル(値だけの MeshStandardMaterial と、アルベドをノードで組む
// MeshStandardNodeMaterial のどちらでも)かどうか。
export function isStandardMaterial(material: THREE.Material): boolean {
  const m = material as THREE.MeshStandardMaterial & THREE.MeshStandardNodeMaterial;
  return m.isMeshStandardMaterial === true || m.isMeshStandardNodeMaterial === true;
}

// root 以下を走査し、標準マテリアルを持つ Mesh(マテリアル配列中の1つでも該当すれば)を
// チャンネル0から外して LIT_OPAQUE_LAYER だけへ置く。それ以外のマテリアルは無視するので、
// 組み立て済みのオブジェクトへ何度呼んでも、またどの段階で呼んでも安全。
export function markLitOpaque(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.Material | THREE.Material[];
    const isStandard = Array.isArray(material)
      ? material.some(isStandardMaterial)
      : isStandardMaterial(material);
    if (isStandard) mesh.layers.set(LIT_OPAQUE_LAYER);
  });
}
