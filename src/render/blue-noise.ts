// 画素ごとに固定の 0..1 の疑似乱数を、焼き込んだ blue noise タイル(tools/export-blue-noise.mjs)
// から引く器。積分の刻みをずらす、ディザを掛ける、といった「画素ごとに違う値が要る」用途に使う。
//
// **欲しいのは値のランダムさではなく、近傍の画素どうしで誤差が打ち消し合うこと。** 画素1つぶんの
// 誤差の大きさは 0..1 の一様な列ならどれを使っても変わらず、目に見えるのは局所平均の誤差だけ
// なので、そこを小さくできる列だけが絵の質を上げる。blue noise はそれを、格子(規則的な模様として
// 見えてしまう)ではない形で満たす。
//
// **画素座標だけから引くので時間で動かない。** 動くノイズは、静止した絵ではちらつきとして目に付く。
// 動く面へ掛けるディザは、画面ではなく面へ貼った値(atSurface)を使う — 画面に固定した値の上を面が
// 滑ると、それもちらつきになる。
import * as THREE from 'three/webgpu';
import { abs, ceil, float, floor, greaterThanEqual, ivec2, log2, mod, screenCoordinate, select, textureLoad, vec2 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec3Node } from './tsl-types';
import { BLUE_NOISE_TILE_BASE64, BLUE_NOISE_TILE_SIZE } from './blue-noise-tile.generated';

// 天体に貼る段の基準のマスの一辺 [面の座標]。段はこの 2 の冪倍。
const SURFACE_LEVEL_BASE = 2 ** -30;
// 段を選ぶ値を読むマスのずらし。同じ段の値と相関しない位置を読む。
const SELECTOR_SHIFT = vec2(29, 17);

export class BlueNoise {
  private readonly tile: THREE.DataTexture;

  // タイルを 1 枚だけ GPU へ載せる。解放は呼び出し側が dispose で行う。
  public constructor() {
    const bytes = Uint8Array.from(atob(BLUE_NOISE_TILE_BASE64), (c) => c.charCodeAt(0));
    this.tile = new THREE.DataTexture(
      bytes, BLUE_NOISE_TILE_SIZE, BLUE_NOISE_TILE_SIZE, THREE.RedFormat, THREE.UnsignedByteType,
    );
    this.tile.needsUpdate = true;
  }

  // いま塗っている画素の 0..1。**テクセルを整数で直に読む** — 補間もラップ設定も挟まないので、
  // 画面の向きや解像度がどうであれ、1画素が必ずタイルの1テクセルに対応する。
  public atScreenPixel(): FloatNode {
    const texel = mod(floor(screenCoordinate.xy), BLUE_NOISE_TILE_SIZE);
    return textureLoad(this.tile, ivec2(texel)).r;
  }

  // 天体に固定した単位方向 direction の 0..1。pixelAngle はその画素が張る角 [rad]。**画面ではなく天体に
  // 貼り付けた blue noise** — 視点が動いても、値は地表に対して止まっている。立方体の面の座標でタイルを
  // 敷き、マスの一辺を 1〜2 画素になる 2 の冪の段に取る。段の境目で模様が跳ばないよう、1 画素の段と
  // その 1 つ細かい段のどちらを読むかを、マスごとに固定の別の値と、境目までの近さで決める。
  public atSurface(direction: Vec3Node, pixelAngle: FloatNode): FloatNode {
    const a = abs(direction);
    const onX = greaterThanEqual(a.x, a.y).and(greaterThanEqual(a.x, a.z));
    const onY = greaterThanEqual(a.y, a.z).and(onX.not());
    const major = select(onX, a.x, select(onY, a.y, a.z));
    // 面の座標(−1..1)。面ごとにタイルの位置をずらして、向かい合う面が同じ模様にならないようにする。
    const face = select(onX, direction.yz, select(onY, direction.zx, direction.xy)).div(major);
    const faceShift = select(onX, vec2(0, 0), select(onY, vec2(23, 41), vec2(47, 11)))
      .add(select(direction.x.add(direction.y).add(direction.z).lessThan(0), vec2(31, 7), vec2(0, 0)));
    // 面の座標で測った 1 画素の幅。面の中心からの傾きぶん、角より座標の刻みが細かくなる。
    const pixel = pixelAngle.div(major.mul(major));
    const level = log2(pixel.div(SURFACE_LEVEL_BASE));
    const coarse = ceil(level);
    const fine = coarse.sub(1);
    // 粗い段のマスは 1〜2 画素。2 画素に近いほど、細かい段(0.5〜1 画素)へ寄せる。
    const towardFine = coarse.sub(level);
    const cellOf = (step: FloatNode): Vec2Node => floor(face.div(float(SURFACE_LEVEL_BASE).mul(step.exp2())));
    const coarseCell = cellOf(coarse);
    const pick = this.tileAt(coarseCell.add(SELECTOR_SHIFT).add(faceShift));
    const coarseValue = this.tileAt(coarseCell.add(faceShift));
    const fineValue = this.tileAt(cellOf(fine).add(faceShift));
    return select(pick.lessThan(towardFine), fineValue, coarseValue);
  }

  // 整数のマス cell(負も可)のタイルの値。
  private tileAt(cell: Vec2Node): FloatNode {
    return textureLoad(this.tile, ivec2(mod(mod(cell, BLUE_NOISE_TILE_SIZE).add(BLUE_NOISE_TILE_SIZE), BLUE_NOISE_TILE_SIZE))).r;
  }

  // 載せたタイルを解放する。
  public dispose(): void {
    this.tile.dispose();
  }
}
