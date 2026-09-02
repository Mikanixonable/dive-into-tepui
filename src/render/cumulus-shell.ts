// 積雲(雲の場の R = 被覆率)を、地表の上に浮く不透明な殻として描くメッシュ。分割段ラダーの
// 各段ぶんの球を1枚のマテリアルで束ね、見かけ直径に応じて1段だけを見せる。被覆率は二値化し、
// 覆われていない画素は捨てる。陰影・遮蔽・逆二乗の減衰はすべてパイプラインが与える。
import * as THREE from 'three/webgpu';
import { Discard, Fn, clamp, texture as textureNode, uv, vec3 } from 'three/tsl';
import { BlueNoise } from './blue-noise';
import { DeferredTexture } from './deferred-texture';
import { unitSphereGeometry } from './celestial-surface';
import { markLitOpaque } from './pipeline/lit-layer';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';

// 雲の場の G(雲頂高度)が張る高さ [m]。殻はその上限へ置く(`render/cloud/cloud-field.ts`)。
const CLOUD_TOP_SPAN = 15000;

// 不透明な積雲のアルベド。厚い雲の白さは多重散乱の産物で、単散乱アルベド ≈ 1・光学的厚みが
// 十分に大きい層の反射は拡散反射の極限へ漸近する。
const CUMULUS_ALBEDO = 0.8;
// 雲の粗さ。雲は拡散する面なので、粗さは最大になる。
const CUMULUS_ROUGHNESS = 1;

// 被覆率を二値化するときの、覆いが無いと見なす下限と覆い尽くされていると見なす上限。あいだの
// 中間調はディザで散らす。**帯は場の被覆率の平均を動かさないように選ぶ** — 実写を分離した
// `src/assets/cloud-field.png` ではこの帯が平均 0.125(緯度余弦で重みを付けた面積平均)を
// 保つので、場を差し替えたら測り直す。
const COVERAGE_CLEAR = 0.25;
const COVERAGE_SOLID = 0.45;

// ディザの閾値の段数。blue noise は 0..1 の両端を含むので、閾値は半段ぶん内側へ寄せて使う
// — 寄せないと、覆いの無い空へ閾値 0 の画素だけが雲として残り、覆い尽くされた面から閾値 1 の
// 画素が抜ける。
const DITHER_LEVELS = 256;

export class CumulusShell {
  private readonly fieldMap: DeferredTexture;
  private readonly material: THREE.Material;
  private readonly blueNoise = new BlueNoise();
  // 段ごとの球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  // fieldUrl は雲の場、bodyRadius は殻を載せる天体の基準半径 [m]。親は半径 bodyRadius の球へ
  // 合わせたスケールを与えればよく、雲頂ぶんの膨らみはこの殻が持つ。
  public constructor(fieldUrl: string, bodyRadius: number) {
    this.fieldMap = new DeferredTexture(fieldUrl, THREE.NoColorSpace);
    // 正距円筒の経度は周期的なので、場は経度方向へ巻く。
    this.fieldMap.texture.wrapS = THREE.RepeatWrapping;
    this.material = this.buildMaterial();

    const shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius;
    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), this.material);
      mesh.scale.setScalar(shellScale);
      mesh.visible = false;
      markLitOpaque(mesh);
      meshes.set(level, mesh);
    }
    this.meshes = meshes;
  }

  // 雲の場のテクスチャ。解放までこの殻が持つ。
  public get field(): THREE.Texture { return this.fieldMap.texture; }

  // 全段のメッシュを parent の下へ置き、場の画像の取得を始める。
  public addTo(parent: THREE.Object3D): void {
    this.fieldMap.request();
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュだけを見せる。
  public syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  // 全段のメッシュを隠す。次の syncLod で段を選び直す。
  public hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  // 全段のメッシュを親から外し、マテリアル・場・ディザのタイルを解放する。
  public dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
    this.fieldMap.dispose();
    this.blueNoise.dispose();
  }

  // 被覆率で二値化した不透明な白の標準マテリアル。覆われていない画素はここで捨てる。
  private buildMaterial(): THREE.Material {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: CUMULUS_ROUGHNESS, metalness: 0,
    });
    material.colorNode = Fn(() => {
      // 被覆率を帯の中で 0..1 へ伸ばし、画素ごとに固定のディザ閾値と比べて雲の有無を決める。
      const coverage = textureNode(this.fieldMap.texture, uv()).r;
      const opaqueFraction = clamp(
        coverage.sub(COVERAGE_CLEAR).div(COVERAGE_SOLID - COVERAGE_CLEAR), 0, 1);
      const threshold = this.blueNoise.atScreenPixel()
        .mul((DITHER_LEVELS - 1) / DITHER_LEVELS).add(0.5 / DITHER_LEVELS);
      Discard(opaqueFraction.lessThan(threshold));
      return vec3(CUMULUS_ALBEDO);
    })();
    return material;
  }
}
