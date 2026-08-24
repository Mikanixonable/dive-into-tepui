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
// 3D 空間に居るが物理的な明るさを持たない表示物(軌道線・軌跡線・天球グリッド・縮尺グリッド・
// Δv ギズモ)の専用チャンネル。合成パスの後ろで描かれるので、露出もトーンマッピングも受けず、
// 指定した色がそのまま画面へ出る。LIT_OPAQUE_LAYER と同じくチャンネル0からは外す。
export const OVERLAY_LAYER = 3;
// タンパク質の半透明外殻だけをライト空間の遮蔽器として描く層。
export const PROTEIN_SHADOW_OCCLUDER_LAYER = 4;
// タンパク質内部のリボンだけを画面空間の自己影の受け手として描く層。
export const PROTEIN_SHADOW_RECEIVER_LAYER = 5;
// 太陽光の影を落とす不透明メッシュ(艦艇・基地・デブリなど)の層。**天体の球はここへ入れない** —
// 球の影は遮蔽関数が解析式で厳密に解いており、シャドウマップにも入れると半影の途中で二重に効く。
export const SUN_SHADOW_CASTER_LAYER = 6;

// マテリアルパスが見るチャンネル。シーンルートは全チャンネルを持つ必要があるため、呼び出し側は
// このマスクを設定する前に scene.layers.enableAll() を済ませておく。
export function setOpaquePassLayers(camera: THREE.Camera): void {
  camera.layers.set(LIT_OPAQUE_LAYER);
  camera.layers.enable(WORLD_BACKGROUND_LAYER);
}

// 3D UI パスが見るチャンネル。gbuffer.ts / material-pass.ts と同じく、呼び出し側は
// camera.layers.mask を呼び出し前の値へ戻す責任を持つ。
export function setOverlayPassLayers(camera: THREE.Camera): void {
  camera.layers.set(OVERLAY_LAYER);
}

// root 以下のすべてを 3D UI チャンネルだけへ置く。markLitOpaque と違ってマテリアルは見ない —
// 表示値として描くかどうかはマテリアルの種類ではなく、その物体が何であるかで決まる。
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

// root 以下の標準マテリアルの Mesh を、太陽光の影を落とす遮蔽器として印す。markLitOpaque と
// 違って set ではなく enable — G バッファからは外さない。
//
// **タンパク質の半透明外殻だけは除く。** 外殻は ProteinShadowPass が受け手を内部リボンへ
// 限って別に扱っており、一般のアトラスにも入れると同じ外殻が二重に影を落とす。除外を
// 呼び出し側の作法にすると落としたときに絵でしか気付けないので、ここで閉じる。
export function markSunShadowCaster(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj.userData.proteinShadowOccluder === true) return;
    if (isStandardMesh(obj)) obj.layers.enable(SUN_SHADOW_CASTER_LAYER);
  });
}

// タンパク質の自己影パスが参照する役割を、通常の lit 層と重ねて有効にする。層を set せず
// enable するので、GBuffer/MaterialPass からタンパク質を外さない。
export function markProteinShadowLayers(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj.userData.proteinShadowOccluder === true) obj.layers.enable(PROTEIN_SHADOW_OCCLUDER_LAYER);
    if (obj.userData.proteinShadowReceiver === true) obj.layers.enable(PROTEIN_SHADOW_RECEIVER_LAYER);
  });
}
