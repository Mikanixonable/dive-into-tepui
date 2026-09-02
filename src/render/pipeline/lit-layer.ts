// 描画パスがどのオブジェクトを描くかを分ける層(three の Layers チャンネル)と、その印を付ける関数。
import * as THREE from 'three/webgpu';

// シーン照明を受ける不透明物(艦艇・基地・デブリ・天体の球)のチャンネル。既定のチャンネル0から
// 外してここへ移すので、印を付けたメッシュは陰影を組む経路だけで描かれる。
export const LIT_OPAQUE_LAYER = 1;
// 星空のように自照式で、不透明物より先に色を書く背景のチャンネル。LIT_OPAQUE_LAYER と同じ
// カメラで描かれるので、renderOrder で不透明物との前後を決められる。
export const WORLD_BACKGROUND_LAYER = 2;
// 3D 空間に居るが物理的な明るさを持たない表示物(軌道線・軌跡線・天球グリッド・縮尺グリッド・
// Δv ギズモ)の専用チャンネル。合成パスの後ろで描かれるので、露出もトーンマッピングも受けず、
// 指定した色がそのまま画面へ出る。LIT_OPAQUE_LAYER と同じくチャンネル0からは外す。
const OVERLAY_LAYER = 3;
// 太陽光の影を落とす不透明メッシュ(艦艇・基地・デブリなど)の層。**天体の球はここへ入れない** —
// 球の影は遮蔽関数が解析式で厳密に解いており、シャドウマップにも入れると半影の途中で二重に効く。
export const SUN_SHADOW_CASTER_LAYER = 4;

// マテリアルパスが見るチャンネル。シーンルートは全チャンネルを持つ必要があるため、呼び出し側は
// このマスクを設定する前に scene.layers.enableAll() を済ませておく。
export function setOpaquePassLayers(camera: THREE.Camera): void {
  camera.layers.set(LIT_OPAQUE_LAYER);
  camera.layers.enable(WORLD_BACKGROUND_LAYER);
}

// 3D UI パスが見るチャンネル。呼び出し側は camera.layers.mask を呼び出し前の値へ戻す責任を持つ。
export function setOverlayPassLayers(camera: THREE.Camera): void {
  camera.layers.set(OVERLAY_LAYER);
}

// root 以下のすべてを 3D UI チャンネルだけへ置く。表示値として描くかどうかはマテリアルの種類では
// なく、その物体が何であるかで決まるので、マテリアルは見ない。
export function markOverlay(root: THREE.Object3D): void {
  root.traverse((obj) => obj.layers.set(OVERLAY_LAYER));
}

// 標準マテリアル(値だけの MeshStandardMaterial と、アルベドをノードで組む
// MeshStandardNodeMaterial のどちらでも)かどうか。
export function isStandardMaterial(material: THREE.Material): boolean {
  const m = material as THREE.MeshStandardMaterial & THREE.MeshStandardNodeMaterial;
  return m.isMeshStandardMaterial === true || m.isMeshStandardNodeMaterial === true;
}

// obj が標準マテリアルを持つ Mesh か(マテリアル配列中の1つでも該当すればよい)。
function isStandardMesh(obj: THREE.Object3D): boolean {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh) return false;
  const material = mesh.material as THREE.Material | THREE.Material[];
  return Array.isArray(material) ? material.some(isStandardMaterial) : isStandardMaterial(material);
}

// root 以下を走査し、標準マテリアルを持つ Mesh(マテリアル配列中の1つでも該当すれば)を
// チャンネル0から外して LIT_OPAQUE_LAYER だけへ置く。それ以外のマテリアルは無視するので、
// 組み立て済みのオブジェクトへ何度呼んでも、またどの段階で呼んでも安全。
export function markLitOpaque(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (isStandardMesh(obj)) obj.layers.set(LIT_OPAQUE_LAYER);
  });
}

// root 以下の標準マテリアルの Mesh を、太陽光の影を落とす遮蔽器として印す。いま属している
// チャンネルはそのまま残す。
export function markSunShadowCaster(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (isStandardMesh(obj)) obj.layers.enable(SUN_SHADOW_CASTER_LAYER);
  });
}
