// 地表配信物のランタイムwire契約。ESTN/ESTBとtile-indexの検証・decodeが共有する。

export const EARTH_SURFACE_TILE_INDEX_SCHEMA_VERSION = 2;
export const EARTH_SURFACE_TERRAIN_FORMAT_VERSION = 2;
export const EARTH_TERRAIN_HEADER_BYTES = 32;
export const EARTH_TERRAIN_WIDTH = 260;
export const EARTH_TERRAIN_HEIGHT = 260;
export const EARTH_TERRAIN_CHANNELS = 4;
export const EARTH_TERRAIN_SCALAR_UINT8 = 2;
export const EARTH_TERRAIN_BYTES = EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * EARTH_TERRAIN_CHANNELS;
export const EARTH_TERRAIN_LAYOUT = 'octahedral-rg8-roughness-r8-material-class-a8';

export const EARTH_TERRAIN_MATERIAL_CLASSES = {
  water: 0,
  land: 1,
  ice: 2,
  unknown: 255,
} as const;
