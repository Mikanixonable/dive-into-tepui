import * as THREE from 'three/webgpu';
import {
  abs, clamp, exp2, float, floor, Fn, greaterThanEqual, If, int, max, min, mix, normalize, select, texture, vec2, vec3, vec4,
} from 'three/tsl';
import type { BoolNode, FloatNode, Mat3Node, Vec2Node, Vec3Node, Vec4Node } from './tsl-types';
import { earthSurfaceUvFromRadialNode } from './earth-surface-coordinate';
import { configureEarthSurfaceTexture } from './earth-surface-texture';
import {
  EARTH_BASE_LAYER, EARTH_TILE_EXTENT, EARTH_TILE_GUTTER, EARTH_TILE_LAYERS, EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z,
  EARTH_TILE_TEXELS,
} from './earth-surface-tile-key';

export interface EarthSurfaceMaterialCapabilities {
  readonly useBaseFallback: boolean;
}

export interface EarthSurfaceMaterialNodeTextures {
  readonly pageTable: THREE.Texture;
  readonly color: THREE.Texture;
  readonly terrain: THREE.Texture;
  readonly baseColor: THREE.Texture;
  readonly baseTerrain: THREE.Texture;
}

export interface EarthSurfaceMaterialNodeInputs {
  // bodyDirectionは地球中心からフラグメントへ向かう天体固定の放射方向。
  readonly bodyDirection: Vec3Node;
  readonly axes: Vec3Node;
  // 幾何法線はすでにview空間へ変換済みの値を受ける。
  readonly geometricNormalView: Vec3Node;
  readonly bodyToView: Mat3Node;
  readonly schematic: BoolNode;
}

export interface EarthSurfaceMaterialNodes {
  readonly colorNode: Vec3Node;
  readonly roughnessNode: FloatNode;
  readonly normalNode: Vec3Node;
}

// 全球地理UVを、指定LODのタイル内UVへ写す。v=1は南端の最終画素側へ残す。
export function earthSurfaceTileUvNode(uv: Vec2Node, z: FloatNode): Vec2Node {
  const rows = exp2(z);
  const columns = rows.mul(2);
  const localU = uv.x.mul(columns).fract();
  const localV = select(uv.y.equal(1), 1, uv.y.mul(rows).fract());
  return vec2(
    localU.mul(EARTH_TILE_TEXELS).add(EARTH_TILE_GUTTER + 0.5).div(EARTH_TILE_EXTENT),
    localV.mul(EARTH_TILE_TEXELS).add(EARTH_TILE_GUTTER + 0.5).div(EARTH_TILE_EXTENT),
  );
}

// ページ表のbase sentinelを詳細配列の有効LODへ戻す。base分岐でも詳細標本ノードは
// グラフへ含まれるため、sentinelをそのままexp2へ渡さない。
export function earthSurfaceDetailLodNode(z: FloatNode): FloatNode {
  return min(max(z, EARTH_TILE_MIN_Z), EARTH_TILE_MAX_Z);
}

// 詳細配列の指定層から、地理UVに対応するタイル値を読む。
function sampleArray(textureValue: THREE.Texture, uv: Vec2Node, z: FloatNode, layer: FloatNode): Vec4Node {
  // DataArrayTextureの層はdepthへ渡す。base層(255)は後段でbase画像へ切り替えるため、
  // 配列の範囲内へクランプした値だけを実際のサンプラへ渡す。
  const safeLayer = min(layer, EARTH_TILE_LAYERS - 1);
  const safeZ = earthSurfaceDetailLodNode(z);
  return texture(textureValue, earthSurfaceTileUvNode(uv, safeZ)).depth(int(safeLayer)).level(float(0));
}

// base画像から色または地形の値を直接読む。
function sampleBase(textureValue: THREE.Texture, uv: Vec2Node): Vec4Node {
  return texture(textureValue, uv).level(float(0));
}

// 現在層を読み、baseまたは親から遷移している画素に限って追加の標本を読む。
function sampleLodTexture(
  detailTexture: THREE.Texture, baseTexture: THREE.Texture, uv: Vec2Node, z: FloatNode,
  layer: FloatNode, parentLayer: FloatNode, fade: FloatNode,
): Vec4Node {
  // 現在層を読み、ページ表がbaseを指す場合はbase画像へ切り替える。
  const currentBase = greaterThanEqual(layer, EARTH_BASE_LAYER);
  const parentBase = greaterThanEqual(parentLayer, EARTH_BASE_LAYER);
  return Fn(() => {
    const value = vec4(0).toVar();
    If(currentBase, () => {
      value.assign(sampleBase(baseTexture, uv));
    }).Else(() => {
      // 詳細層が親から遷移中なら、親の値と現在層をfadeで混ぜる。
      value.assign(sampleArray(detailTexture, uv, z, layer));
      If(fade.lessThan(1), () => {
        const previous = vec4(0).toVar();
        If(parentBase, () => {
          previous.assign(sampleBase(baseTexture, uv));
        }).Else(() => {
          previous.assign(sampleArray(detailTexture, uv, max(z.sub(1), EARTH_TILE_MIN_Z), parentLayer));
        });
        value.assign(mix(previous, value, fade));
      });
    });
    return value;
  })() as Vec4Node;
}

// 正規化八面体RGを天体固定の単位法線へ戻す。
export function decodeEarthSurfaceOctNormalNode(encoded: Vec2Node): Vec3Node {
  const folded = encoded.mul(2).sub(1);
  const z = float(1).sub(abs(folded.x)).sub(abs(folded.y));
  const correction = clamp(z.negate(), 0, 1);
  const x = folded.x.add(select(folded.x.greaterThanEqual(0), correction.negate(), correction));
  const y = folded.y.add(select(folded.y.greaterThanEqual(0), correction.negate(), correction));
  return normalize(vec3(x, y, z));
}

// 地球固定法線→共通地理UV→ページ表→現在/親層→色・法線・roughnessを一つのTSLグラフへ組む。
// colorテクスチャはSRGBColorSpaceで設定されているため、texture()の出力は線形作業色空間へ変換される。
export function earthSurfaceMaterialNodes(
  textures: EarthSurfaceMaterialNodeTextures,
  inputs: EarthSurfaceMaterialNodeInputs,
): EarthSurfaceMaterialNodes {
  // 各入力テクスチャの読み取り規則を固定する。
  configureEarthSurfaceTexture(textures.pageTable, 'pageTable');
  configureEarthSurfaceTexture(textures.color, 'color');
  configureEarthSurfaceTexture(textures.terrain, 'terrain');
  configureEarthSurfaceTexture(textures.baseColor, 'color');
  configureEarthSurfaceTexture(textures.baseTerrain, 'terrain');

  // 共通の地理UVからページ表と色・地形の層を読む。
  const uv = earthSurfaceUvFromRadialNode(inputs.bodyDirection, inputs.axes);
  const page = texture(textures.pageTable, uv);
  const layer = floor(page.r.mul(255).add(0.5));
  const parentLayer = floor(page.g.mul(255).add(0.5));
  const z = floor(page.b.mul(255).add(0.5));
  const fade = page.a;
  const colorNode = sampleLodTexture(
    textures.color, textures.baseColor, uv, z, layer, parentLayer, fade,
  ).rgb;
  const terrain = sampleLodTexture(
    textures.terrain, textures.baseTerrain, uv, z, layer, parentLayer, fade,
  );
  const normalBody = decodeEarthSurfaceOctNormalNode(terrain.rg);
  // 地形法線をviewへ変換し、模式図では幾何法線へ切り替える。
  const normalView = normalize(inputs.bodyToView.mul(normalBody));
  const normalNode = select(inputs.schematic, inputs.geometricNormalView, normalView);

  return { colorNode, roughnessNode: terrain.b, normalNode };
}

// 共通のMeshStandardNodeMaterialへ接続する入口。base-only時は呼び手が既存のCelestialSurfaceを使う。
export function createEarthSurfaceNodeMaterial(
  textures: EarthSurfaceMaterialNodeTextures,
  inputs: EarthSurfaceMaterialNodeInputs,
): THREE.MeshStandardNodeMaterial {
  const nodes = earthSurfaceMaterialNodes(textures, inputs);
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 1 });
  material.colorNode = vec4(nodes.colorNode, 1);
  material.roughnessNode = nodes.roughnessNode;
  material.normalNode = nodes.normalNode;
  return material;
}

// 詳細テクスチャを使う地球表面の材質能力を返す。
export function earthSurfaceMaterialCapabilities(unsupported: boolean): EarthSurfaceMaterialCapabilities {
  return { useBaseFallback: unsupported };
}
