// 撃破時に飛び散る破片1個の表示と、全個体が共有する描画資源。形は数種類のジオメトリ(単位スケール)を
// 一度だけ焼いて全個体で共有し、個体は形をその中から抽選し、色を per-instance color で持つ。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../../math/random';
import { attachThermalEmissive } from '../../thermal-emissive';
import { SHIP_DARK_HULL_COLOR } from '../../vfx-style';
import { memoTemplate } from '../baked-model';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import debrisChunkData from '../../../assets/models/debrisChunk.json';
import debrisPanelData from '../../../assets/models/debrisPanel.json';
import debrisRodData from '../../../assets/models/debrisRod.json';
import type { KinematicState } from '../../../physics/kinematic-state';

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
    const geo = debrisChunkTemplate().geometry.clone();
    displaceVertices(geo, (x, y, z) => [x * (0.5 + rand() * 1.2), y * (0.5 + rand() * 1.2), z * (0.4 + rand() * 1.6)]);
    return geo;
  } else if (kind < 0.42) {
    // 平板パネル
    const geo = debrisPanelTemplate().geometry.clone();
    geo.scale(1.5 + rand() * 1.2, 0.06 + rand() * 0.08, 0.7 + rand() * 0.8);
    return geo;
  } else if (kind < 0.58) {
    // 構造ロッド
    const geo = debrisRodTemplate().geometry.clone();
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

// 飛散片1個。変換だけを持つ表示ルートを、バリアントごとの共有ジオメトリへ積む。
export class DebrisFragmentView extends DynamicView {
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
