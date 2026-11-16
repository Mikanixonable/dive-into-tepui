// 天体の地形データ入力仕様と、地形テクスチャ(正距円筒 RGB8: R 東向き勾配 / G 北向き勾配 /
// B 陸地の重み)を読むその実装。気候の低周波の場とは別に、島や山地の上昇源を解像するための
// 細かい静的な面を持つ。
import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { equirectUvFromDirection } from '../field-projection';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 勾配の符号化の半幅 [m/m]。export-climate.mjs の TERRAIN_SLOPE_RANGE と揃える。
const SLOPE_RANGE = 0.06;

// 天体の地形を単位方向で答える入力。generation は入力(読む画像か、その選択)が変わるたびに進む世代。
export interface TerrainMap {
  readonly generation: number;
  slope(direction: Vec3Node): Vec2Node;
  landFraction(direction: Vec3Node): FloatNode;
  request(): void;
  dispose(): void;
}

// 地形テクスチャを、正距円筒のデータ値のまま線形補間で読める設定にして返す。
function configureTerrainTexture(map: THREE.Texture): THREE.Texture {
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.flipY = false;
  map.generateMipmaps = false;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.colorSpace = THREE.NoColorSpace;
  return map;
}

// 地形テクスチャを読む地形入力。
export class TextureTerrainMap implements TerrainMap {
  // url の PNG を読み終えてから器を返す。
  public static async load(url: string): Promise<TextureTerrainMap> {
    const map = await new THREE.TextureLoader().loadAsync(url);
    return new TextureTerrainMap(configureTerrainTexture(map), null);
  }

  // url の画像の取得を request() まで遅らせる器を返す。
  public static fromDeferredUrl(url: string): TextureTerrainMap {
    const deferred = new DeferredTexture(url, THREE.NoColorSpace);
    return new TextureTerrainMap(configureTerrainTexture(deferred.texture), deferred);
  }

  private constructor(
    private readonly map: THREE.Texture,
    private readonly deferred: DeferredTexture | null,
  ) {}

  // 画像リソースの取得を開始する。fromDeferredUrl で生成された遅延読み込みインスタンスに適用される。
  public request(): void { this.deferred?.request(); }

  // 入力の世代。画像が GPU へ公開されるたびに進む。
  public get generation(): number { return this.deferred?.generation ?? this.map.version; }

  // 斜面の勾配(東向き・北向き成分)[m/m]。
  public slope(direction: Vec3Node): Vec2Node {
    const sample = this.sample(direction);
    return vec2(sample.r, sample.g).mul(2).sub(1).mul(SLOPE_RANGE);
  }

  // 陸地の重み 0..1(大洋で 0、陸の内側で 1、10 km 級の島や湖も残る)。
  public landFraction(direction: Vec3Node): FloatNode {
    return this.sample(direction).b;
  }

  // 単位方向のテクセル(R 東向き勾配 / G 北向き勾配 / B 陸地の重み、それぞれ 0..1)。
  private sample(direction: Vec3Node): Vec4Node {
    return texture(this.map, equirectUvFromDirection(direction));
  }

  // 保持しているテクスチャを解放する。
  public dispose(): void {
    if (this.deferred === null) this.map.dispose();
    else this.deferred.dispose();
  }
}
