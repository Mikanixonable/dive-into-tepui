// フィルムのルック。assets/luts/ に置かれた .cube を候補として並べ、選ばれた1本を合成段の色へ
// 当てる。差し替えはサンプリング先のテクスチャとユニフォームだけで済ませるので、切り替えの
// たびに合成マテリアルを組み直す必要はない。
import * as THREE from 'three/webgpu';
import { clamp, mix, texture3D, uniform } from 'three/tsl';
import type { Vec3Node } from '../tsl-types';

// ルックを当てない選択。.cube のファイル名とは衝突しない。
export const FILM_LUT_NONE = 'none';

const NONE_LABEL = 'なし';

// 候補1つぶん。id は描画設定の選択肢の値であり、保存された設定を読む鍵でもある
// (.cube を改名すると、保存済みの選択は「なし」へ戻る)。
interface FilmLutFile {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

// .cube の中身。格子の一辺と、RGBA 半精度で並べた格子点の色。
interface CubeLut {
  readonly size: number;
  readonly data: Uint16Array;
}

// TITLE は .cube の任意フィールドなので、無い .cube もそのまま候補になる。
const TITLE_LINE = /^TITLE\s+"(.+)"\s*$/m;

// assets/luts/ の .cube をファイル名順に集める。表示名は TITLE 行、無ければファイル名。
function collectFiles(): readonly FilmLutFile[] {
  const context = require.context('../../assets/luts', false, /\.cube$/);
  return context.keys().sort().map((key) => {
    const text = context(key);
    const id = key.replace(/^\.\//, '').replace(/\.cube$/, '');
    return { id, label: TITLE_LINE.exec(text)?.[1] ?? id, text };
  });
}

const FILM_LUT_FILES = collectFiles();

// 描画設定が並べる選択肢。先頭が「なし」で、以降は同梱された .cube ぶん。
export const FILM_LUT_ITEMS: readonly (readonly [string, string])[] = [
  [FILM_LUT_NONE, NONE_LABEL],
  ...FILM_LUT_FILES.map((file) => [file.id, file.label] as const),
];

function parseCube(text: string): CubeLut {
  let size = 0;
  const values: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^(TITLE|DOMAIN_MIN|DOMAIN_MAX)\b/i.test(line)) continue;

    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }

    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`Invalid CUBE LUT row: ${line}`);
    }
    values.push(parts[0]!, parts[1]!, parts[2]!, 1);
  }

  const expected = size * size * size * 4;
  if (size <= 1 || values.length !== expected) {
    throw new Error(`Invalid CUBE LUT: expected ${expected / 4} RGB rows, got ${values.length / 4}`);
  }
  return { size, data: Uint16Array.from(values, (v) => THREE.DataUtils.toHalfFloat(v)) };
}

// ルックを選んでいないときサンプラーへ繋いでおく、角の8点だけの LUT。
// **これを「なし」の実体には使えない** — 標本器が [0,1] 全体を1区間で補間することになり、
// その刻みの粗さが暗部で表示用の色空間へ乗ったときに見えるずれになる。
function placeholderCube(): CubeLut {
  const ends = [0, 1];
  const values: number[] = [];
  for (const b of ends) for (const g of ends) for (const r of ends) values.push(r, g, b, 1);
  return { size: 2, data: Uint16Array.from(values, (v) => THREE.DataUtils.toHalfFloat(v)) };
}

const PLACEHOLDER_CUBE = placeholderCube();

// LUT は各軸の両端の格子点を 0 と 1 に置くので、[0,1] の色は両端の texel 中心の間へ写す。
// 色をそのまま uvw にすると端が半 texel ぶん外を指し、端の色が寝る。
function uvwScale(size: number): number { return (size - 1) / size; }
function uvwOffset(size: number): number { return 0.5 / size; }

function buildTexture(cube: CubeLut): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(cube.data, cube.size, cube.size, cube.size);
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

// 合成段の色へ当てるルック。サンプリングするノードは1本だけ持ち、差し替えはその参照先の
// テクスチャと格子の寸法で行う — 組み上がったマテリアルをそのまま使い続けるため。
export class FilmLut {
  private id = FILM_LUT_NONE;
  private texture = buildTexture(PLACEHOLDER_CUBE);
  private readonly sampler = texture3D(this.texture);
  private readonly scale = uniform(uvwScale(PLACEHOLDER_CUBE.size));
  private readonly offset = uniform(uvwOffset(PLACEHOLDER_CUBE.size));
  // ルックを当てる割合。「なし」の 0 では素通しがそのまま画面へ出る。
  private readonly amount = uniform(0);

  // 色へルックを当てる。マテリアルを組むときに呼ぶ。
  public apply(color: Vec3Node): Vec3Node {
    const graded = this.sampler.sample(clamp(color, 0, 1).mul(this.scale).add(this.offset)).rgb;
    return mix(color, graded, this.amount) as Vec3Node;
  }

  // 当てるルックを差し替える。候補に無い名前(「なし」と、消えた .cube を指す保存値)は
  // ルックを当てない。
  public select(id: string): void {
    if (id === this.id) return;
    const file = FILM_LUT_FILES.find((candidate) => candidate.id === id);
    const cube = file === undefined ? PLACEHOLDER_CUBE : parseCube(file.text);
    this.texture.dispose();
    this.id = id;
    this.texture = buildTexture(cube);
    this.sampler.value = this.texture;
    this.scale.value = uvwScale(cube.size);
    this.offset.value = uvwOffset(cube.size);
    this.amount.value = file === undefined ? 0 : 1;
  }

  public dispose(): void {
    this.texture.dispose();
  }
}
