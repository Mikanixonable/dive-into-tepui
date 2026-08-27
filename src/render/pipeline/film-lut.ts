import * as THREE from 'three/webgpu';
import { clamp, texture3D, vec3 } from 'three/tsl';
import type { Vec3Node } from '../tsl-types';

interface CubeLut {
  title: string;
  size: number;
  data: Uint16Array;
}

function parseCube(source: string): CubeLut {
  let title = '3D LUT';
  let size = 0;
  const values: number[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const titleMatch = line.match(/^TITLE\s+"(.+)"$/i);
    if (titleMatch) {
      title = titleMatch[1]!;
      continue;
    }

    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }

    if (/^(DOMAIN_MIN|DOMAIN_MAX)\b/i.test(line)) continue;

    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`Invalid CUBE LUT row: ${line}`);
    }
    values.push(parts[0]!, parts[1]!, parts[2]!, 1);
  }

  const expected = size * size * size * 4;
  if (size <= 1 || values.length !== expected) {
    throw new Error(`Invalid ${title} CUBE LUT: expected ${expected / 4} RGB rows, got ${values.length / 4}`);
  }

  return { title, size, data: Uint16Array.from(values, (v) => THREE.DataUtils.toHalfFloat(v)) };
}

function buildTexture(cube: CubeLut): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(cube.data, cube.size, cube.size, cube.size);
  texture.name = cube.title;
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function loadActiveCube(): CubeLut | null {
  const context = require.context('../../assets/luts', false, /\.cube$/);
  const keys = context.keys().sort();
  const activeKey = keys.at(-1);
  return activeKey ? parseCube(context(activeKey)) : null;
}

const activeCube = loadActiveCube();
const activeTexture = activeCube ? buildTexture(activeCube) : null;
const lutScale = activeCube ? (activeCube.size - 1) / activeCube.size : 1;
const lutOffset = activeCube ? 0.5 / activeCube.size : 0;

export function applyActiveFilmLut(color: Vec3Node): Vec3Node {
  if (activeTexture === null) return color;
  const uvw = clamp(color, 0, 1).mul(lutScale).add(vec3(lutOffset));
  return texture3D(activeTexture, uvw).rgb as Vec3Node;
}
