// 破片1個の表示。撃破時の飛散片・排出された砲身/マガジン枠/薬莢・分離した段間カバーの部品を、
// 見た目ごとのメッシュで描く。飛散片と薬莢の描画資源は全個体で共有する。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../../math/random';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { attachThermalEmissive, makeThermallyEmissive } from '../../thermal-emissive';
import { SHIP_DARK_HULL_COLOR } from '../../vfx-style';
import { memoParseIndependent, memoTemplate } from '../baked-model';
import { buildBoosterExplosiveBoltMesh, buildBoosterInterstageCoverPanelMesh } from '../booster-model';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import barrelData from '../../../assets/models/barrel.json';
import casingData from '../../../assets/models/casing.json';
import debrisChunkData from '../../../assets/models/debrisChunk.json';
import debrisPanelData from '../../../assets/models/debrisPanel.json';
import debrisRodData from '../../../assets/models/debrisRod.json';
import magazineData from '../../../assets/models/magazine.json';
import type { KinematicState } from '../../../physics/kinematic-state';

// 破片1個をどのメッシュで描くか。accent / size / segment は、その見た目を決めるための値。
export type DebrisPieceVariant =
  | { readonly kind: 'fragment'; readonly accent: string | number; readonly size: number }
  | { readonly kind: 'barrel' }
  | { readonly kind: 'magazineFrame' }
  | { readonly kind: 'casing' }
  | { readonly kind: 'boosterCover'; readonly segment: number }
  | { readonly kind: 'boosterBolt'; readonly segment: number };

// BufferGeometry を属性・index ごと複製する(clone() だけでは頂点属性配列を共有したままになる)。
function deepCloneGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const clone = geo.clone();
  for (const key in clone.attributes) {
    const attr = clone.attributes[key];
    if (attr) clone.attributes[key] = attr.clone();
  }
  if (clone.index) {
    clone.index = clone.index.clone();
  }
  return clone;
}

// 飛散片(fragment)は DEBRIS_FRAGMENT_VARIANT_COUNT 種類のジオメトリ(単位スケール)を一度だけ焼いて
// 全個体で共有する。個体は形をその中から抽選し、色を per-instance color で持つ。

// 飛散片ジオメトリのバリアント本数。バリアント1本につき InstancedPool が1本増え、G バッファと影パスの
// シェーダが1本ずつ起動時にコンパイルされるので、増やすほど起動が伸びる。**7 を下回らせない** — 形の帯を
// 等間隔に叩くので、これより少ないと 6 つの形のどれかが 1 本も出なくなる。
const DEBRIS_FRAGMENT_VARIANT_COUNT = 7;
// バリアントの寸法を決める乱数のシード(起動のたびに形が変わらないよう固定する)。
const DEBRIS_FRAGMENT_SEED = 0xdeb71;

const debrisChunkTemplate = memoTemplate<THREE.Mesh>(debrisChunkData);
const debrisPanelTemplate = memoTemplate<THREE.Mesh>(debrisPanelData);
const debrisRodTemplate = memoTemplate<THREE.Mesh>(debrisRodData);

// 頂点を index 順に写像して法線を再計算する(乱数を使う写像でも呼び出し順が保たれる)
function displaceVertices(geo: THREE.BufferGeometry, map: (x: number, y: number, z: number) => [number, number, number]): void {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = map(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setXYZ(i, x, y, z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// 飛散片ジオメトリを1つ、単位スケールで生成する。kind [0, 1) が6つの形のどれになるかを決め、
// rand が寸法の細部を決める。個体ごとの最終的な大きさは表示ルートの scale で決まる。
function buildDebrisFragmentGeometry(rand: () => number, kind: number): THREE.BufferGeometry {
  if (kind < 0.22) {
    // 破損した外殻チャンク
    const geo = deepCloneGeometry(debrisChunkTemplate().geometry);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + rand() * 1.2), y * (0.5 + rand() * 1.2), z * (0.4 + rand() * 1.6)]);
    return geo;
  } else if (kind < 0.42) {
    // 平板パネル
    const geo = deepCloneGeometry(debrisPanelTemplate().geometry);
    geo.scale(1.5 + rand() * 1.2, 0.06 + rand() * 0.08, 0.7 + rand() * 0.8);
    return geo;
  } else if (kind < 0.58) {
    // 構造ロッド
    const geo = deepCloneGeometry(debrisRodTemplate().geometry);
    geo.scale(0.8 + rand() * 0.4, 2.2 + rand() * 1.4, 0.8 + rand() * 0.4);
    return geo;
  } else if (kind < 0.72) {
    // 歪んだ八面体
    const geo = new THREE.OctahedronGeometry(1, 0);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + rand() * 1.0), y * (0.5 + rand() * 1.0), z * (0.7 + rand() * 0.9)]);
    return geo;
  } else if (kind < 0.86) {
    // 薄い歪んだ板
    const geo = new THREE.BoxGeometry(1, 1, 1);
    displaceVertices(geo, (x, y, z) => [x + (rand() - 0.5) * 0.35, y + (rand() - 0.5) * 0.35, z * 0.12]);
    geo.scale(1.2 + rand() * 1.0, 1.2 + rand() * 1.0, 0.12);
    return geo;
  } else {
    // 細い棒材
    const geo = new THREE.BoxGeometry(0.15, 1, 0.15);
    geo.scale(0.8 + rand() * 0.4, 2.0 + rand() * 1.6, 0.8 + rand() * 0.4);
    return geo;
  }
}

let debrisFragmentGeometries: THREE.BufferGeometry[] | null = null;
let debrisFragmentMaterial: THREE.MeshStandardNodeMaterial | null = null;

// 飛散片の全個体が共有するジオメトリ群(バリアント)と単一マテリアルを返す。初回に一度だけ構築する。
export function debrisFragmentResources(): { geometries: readonly THREE.BufferGeometry[]; material: THREE.Material } {
  if (!debrisFragmentGeometries) {
    const rand = mulberry32(DEBRIS_FRAGMENT_SEED);
    debrisFragmentGeometries = [];
    // 形の帯を等間隔に叩く。乱択だと本数が少ないときに同じ形へ偏る。
    for (let i = 0; i < DEBRIS_FRAGMENT_VARIANT_COUNT; i++) {
      debrisFragmentGeometries.push(
        buildDebrisFragmentGeometry(rand, (i + 0.5) / DEBRIS_FRAGMENT_VARIANT_COUNT));
    }
    debrisFragmentMaterial = attachThermalEmissive(
      new THREE.MeshStandardNodeMaterial({ color: 0xffffff, flatShading: true, roughness: 0.65, metalness: 0 }),
      'instance');
  }
  return { geometries: debrisFragmentGeometries, material: debrisFragmentMaterial! };
}

class DebrisFragmentView extends DynamicView {
  private readonly fragmentVariant: number;
  private readonly fragmentColor: THREE.Color;

  // どのバリアントジオメトリで、どの色で描くかを生成時に1度だけ抽選する。
  public constructor(accent: string | number, size: number, scene?: THREE.Scene) {
    const root = new THREE.Object3D();
    root.scale.setScalar(size);
    super(root, scene, false);
    this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
    const dark = Math.random() < 0.30;
    this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : accent);
  }

  // 破片はバリアントごとの共有ジオメトリへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
    _displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    context.pools.pushDebrisFragment(this.fragmentVariant, this.object, this.fragmentColor);
  }
}

// 薬莢は全個体が1組の geometry/material を共有する。geometry はテンプレートを一度だけ deep clone して
// 全長補正を焼き込み、material はテンプレートから一度だけ複製したものを不変資源として使う。
const parseCasing = memoParseIndependent<THREE.Mesh>(casingData);
let casingGeometry: THREE.BufferGeometry | null = null;
let casingMaterial: THREE.MeshStandardNodeMaterial | null = null;

// 薬莢の共有 geometry/material を、未生成なら生成する。
function initCasingResources(): void {
  if (casingGeometry && casingMaterial) return;

  const template = parseCasing();
  casingGeometry = deepCloneGeometry(template.geometry);
  casingGeometry.scale(1, 2, 1);
  casingMaterial = template.material as THREE.MeshStandardNodeMaterial;
  casingMaterial.color.setHex(0xFF9F5E);
  casingMaterial.metalness = 0.8;
  casingMaterial.roughness = 0.3;
  // 個体は 1 本の InstancedMesh へ積まれるので、温度は個体ごとの属性から読む。
  attachThermalEmissive(casingMaterial, 'instance');
}

// 全薬莢が共有する geometry/material を返す。
export function casingBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  initCasingResources();
  return { geometry: casingGeometry!, material: casingMaterial! };
}

// 薬莢メッシュを生成する。geometry/material は全個体の共有物。
function buildCasingMesh(): THREE.Mesh {
  initCasingResources();
  const mesh = new THREE.Mesh(casingGeometry!, casingMaterial!);
  mesh.userData.ownsGeometry = false;
  mesh.userData.ownsMaterial = false;
  return mesh;
}

class CasingDebrisView extends DynamicView {
  // 共有資源を指す薬莢メッシュを、プールへ積む変換の担い手として持つ。
  public constructor(scene?: THREE.Scene) {
    super(buildCasingMesh(), scene, false);
  }

  // 薬莢は全個体で共有する1本のプールへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
    _displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    context.pools.pushCasing(this.object);
  }
}

// リロード時に放出される砲身のテンプレート。geometry/material は全個体で共有し、
// 熱の状態は個体ごとの userData が運ぶ。
let barrelTemplate: THREE.Group | null = null;

// 砲身のメッシュをテンプレートから複製して返す。geometry/material は全個体の共有物。
function buildBarrelMesh(): THREE.Group {
  if (barrelTemplate === null) {
    const g = memoTemplate<THREE.Group>(barrelData)();
    makeThermallyEmissive(g);
    g.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.userData.ownsGeometry = false;
      mesh.userData.ownsMaterial = false;
    });
    // layers.mask は Object3D.clone(true) が子孫までコピーするので、テンプレートへ一度だけ印す。
    markLitOpaque(g);
    markShadowCaster(g);
    barrelTemplate = g;
  }
  return barrelTemplate.clone(true) as THREE.Group;
}

// 弾(role === 'round' のメッシュ)を抜いた、外枠だけのマガジンのテンプレート。
const parseMagazine = memoParseIndependent<THREE.Group>(magazineData);
let magazineFrameTemplate: THREE.Group | null = null;

// 空になって排出されたマガジン枠を複製して返す。geometry/material は全個体の共有物。
function buildMagazineFrame(): THREE.Group {
  if (magazineFrameTemplate === null) {
    const g = parseMagazine();
    // 弾のメッシュを抜いて外枠だけにする。
    for (const child of [...g.children]) {
      if ((child as THREE.Mesh).userData?.['role'] === 'round') g.remove(child);
    }
    // 全個体がテンプレートの geometry/material を共有するので、個体の破棄では解放させない。
    g.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.userData.ownsGeometry = false;
      mesh.userData.ownsMaterial = false;
    });
    magazineFrameTemplate = g;
  }
  return magazineFrameTemplate.clone(true) as THREE.Group;
}

// 見た目ごとの表示。差が生成するメッシュだけのものは DynamicView をそのまま使う。
export function buildDebrisPieceView(variant: DebrisPieceVariant, scene?: THREE.Scene): DynamicView {
  switch (variant.kind) {
    case 'fragment': return new DebrisFragmentView(variant.accent, variant.size, scene);
    case 'barrel': return new DynamicView(buildBarrelMesh(), scene);
    case 'magazineFrame': return new DynamicView(buildMagazineFrame(), scene);
    case 'casing': return new CasingDebrisView(scene);
    case 'boosterCover':
      return new DynamicView(buildBoosterInterstageCoverPanelMesh(variant.segment), scene);
    case 'boosterBolt':
      return new DynamicView(buildBoosterExplosiveBoltMesh(variant.segment), scene);
  }
}
