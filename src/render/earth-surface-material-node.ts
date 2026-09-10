import * as THREE from 'three/webgpu';
import {
  exp2, floor, greaterThanEqual, int, max, min, mix, normalize, select, texture, vec2, vec4,
} from 'three/tsl';
import type { BoolNode, FloatNode, Mat3Node, Vec2Node, Vec3Node, Vec4Node } from './tsl-types';
import { earthSurfaceUvFromRadialNode } from './earth-surface-coordinate';
import {
  EARTH_BASE_LAYER, EARTH_TILE_EXTENT, EARTH_TILE_GUTTER, EARTH_TILE_LAYERS, EARTH_TILE_TEXELS,
} from './earth-surface-tiles';

export type EarthSurfaceMaterialTextureKind = 'pageTable' | 'color' | 'terrain';

export interface EarthSurfaceMaterialTextureSettings {
  readonly minFilter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
  readonly magFilter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
  readonly colorSpace: THREE.ColorSpace;
  readonly generateMipmaps: false;
}

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

const TEXTURE_SETTINGS: Record<EarthSurfaceMaterialTextureKind, EarthSurfaceMaterialTextureSettings> = {
  pageTable: {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
  },
  color: {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
  },
  terrain: {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
  },
};

export function configureEarthSurfaceTexture<T extends THREE.Texture>(
  texture: T,
  kind: EarthSurfaceMaterialTextureKind,
): T {
  const settings = TEXTURE_SETTINGS[kind];
  texture.minFilter = settings.minFilter;
  texture.magFilter = settings.magFilter;
  texture.colorSpace = settings.colorSpace;
  texture.generateMipmaps = settings.generateMipmaps;
  texture.needsUpdate = true;
  return texture;
}

function tileUv(uv: Vec2Node, z: FloatNode): Vec2Node {
  const rows = exp2(z);
  const columns = rows.mul(2);
  const localU = uv.x.mul(columns).fract();
  const localV = uv.y.mul(rows).clamp(0, 1).fract();
  return vec2(
    localU.mul(EARTH_TILE_TEXELS).add(EARTH_TILE_GUTTER + 0.5).div(EARTH_TILE_EXTENT),
    localV.mul(EARTH_TILE_TEXELS).add(EARTH_TILE_GUTTER + 0.5).div(EARTH_TILE_EXTENT),
  );
}

function sampleArray(textureValue: THREE.Texture, uv: Vec2Node, z: FloatNode, layer: FloatNode): Vec4Node {
  // DataArrayTextureの層はdepthへ渡す。base層(255)は後段でbase画像へ切り替えるため、
  // 配列の範囲内へクランプした値だけを実際のサンプラへ渡す。
  const safeLayer = min(layer, EARTH_TILE_LAYERS - 1);
  return texture(textureValue, tileUv(uv, z)).depth(int(safeLayer));
}

function sampleBase(textureValue: THREE.Texture, uv: Vec2Node): Vec4Node {
  return texture(textureValue, uv);
}

// 地球固定法線→共通地理UV→ページ表→現在/親層→色・法線・roughnessを一つのTSLグラフへ組む。
// colorテクスチャはSRGBColorSpaceで設定されているため、texture()の出力は線形作業色空間へ変換される。
export function earthSurfaceMaterialNodes(
  textures: EarthSurfaceMaterialNodeTextures,
  inputs: EarthSurfaceMaterialNodeInputs,
): EarthSurfaceMaterialNodes {
  configureEarthSurfaceTexture(textures.pageTable, 'pageTable');
  configureEarthSurfaceTexture(textures.color, 'color');
  configureEarthSurfaceTexture(textures.terrain, 'terrain');
  configureEarthSurfaceTexture(textures.baseColor, 'color');
  configureEarthSurfaceTexture(textures.baseTerrain, 'terrain');

  const uv = earthSurfaceUvFromRadialNode(inputs.bodyDirection, inputs.axes);
  const page = texture(textures.pageTable, uv);
  const layer = floor(page.r.mul(255).add(0.5));
  const parentLayer = floor(page.g.mul(255).add(0.5));
  const z = floor(page.b.mul(255).add(0.5));
  const fade = page.a;
  const currentBase = greaterThanEqual(layer, EARTH_BASE_LAYER);
  const parentBase = greaterThanEqual(parentLayer, EARTH_BASE_LAYER);

  const detailColor = sampleArray(textures.color, uv, z, layer).rgb;
  const parentColor = sampleArray(textures.color, uv, max(z.sub(1), 0), parentLayer).rgb;
  const baseColor = sampleBase(textures.baseColor, uv).rgb;
  const currentColor = select(currentBase, baseColor, detailColor);
  const previousColor = select(parentBase, baseColor, parentColor);
  const colorNode = select(currentBase, baseColor, mix(previousColor, currentColor, fade));

  const detailTerrain = sampleArray(textures.terrain, uv, z, layer);
  const parentTerrain = sampleArray(textures.terrain, uv, max(z.sub(1), 0), parentLayer);
  const baseTerrain = sampleBase(textures.baseTerrain, uv);
  const currentTerrain = select(currentBase, baseTerrain, detailTerrain);
  const previousTerrain = select(parentBase, baseTerrain, parentTerrain);
  const terrain = select(currentBase, baseTerrain, mix(previousTerrain, currentTerrain, fade));
  const normalBody = normalize(terrain.xyz);
  const normalView = normalize(inputs.bodyToView.mul(normalBody));
  const normalNode = select(inputs.schematic, inputs.geometricNormalView, normalView);

  return { colorNode, roughnessNode: terrain.a, normalNode };
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

export function earthSurfaceMaterialCapabilities(unsupported: boolean): EarthSurfaceMaterialCapabilities {
  return { useBaseFallback: unsupported };
}
