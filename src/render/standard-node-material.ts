// 値だけを持つ標準マテリアルと、シェーダグラフを持てる標準マテリアルの間の橋渡し。
// 見た目を決める色・マップ・面の設定を移し替える 1 箇所を与える。
import * as THREE from 'three/webgpu';

// 標準マテリアルの見た目一式のうち、Node 版のコンストラクタが受け取れるものを写す。
function standardMaterialParams(
  src: THREE.MeshStandardMaterial,
): THREE.MeshStandardNodeMaterialParameters {
  return {
    color: src.color,
    map: src.map,
    roughness: src.roughness,
    roughnessMap: src.roughnessMap,
    metalness: src.metalness,
    metalnessMap: src.metalnessMap,
    normalMap: src.normalMap,
    normalScale: src.normalScale,
    emissive: src.emissive,
    emissiveMap: src.emissiveMap,
    emissiveIntensity: src.emissiveIntensity,
    alphaMap: src.alphaMap,
    transparent: src.transparent,
    opacity: src.opacity,
    side: src.side,
    vertexColors: src.vertexColors,
    depthTest: src.depthTest,
    depthWrite: src.depthWrite,
    alphaTest: src.alphaTest,
    flatShading: src.flatShading,
    wireframe: src.wireframe,
    wireframeLinewidth: src.wireframeLinewidth,
    dithering: src.dithering,
    premultipliedAlpha: src.premultipliedAlpha,
  };
}

// 同じ見た目を持つ Node 版の標準マテリアル。渡されたものが既に Node 版ならそのまま返し、
// そうでなければ移し替えたうえで元を破棄する — 呼び出し側は戻り値へ持ち替える。
export function toStandardNodeMaterial(material: THREE.Material): THREE.MeshStandardNodeMaterial {
  if ((material as THREE.MeshStandardNodeMaterial).isMeshStandardNodeMaterial) {
    return material as THREE.MeshStandardNodeMaterial;
  }
  const src = material as THREE.MeshStandardMaterial;
  const upgraded = new THREE.MeshStandardNodeMaterial(standardMaterialParams(src));
  upgraded.userData = src.userData;
  src.dispose();
  return upgraded;
}
