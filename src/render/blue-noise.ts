// 画素ごとに固定の 0..1 の疑似乱数を、焼き込んだ blue noise タイル(tools/export-blue-noise.mjs)
// から引く器。積分の刻みをずらす、ディザを掛ける、といった「画素ごとに違う値が要る」用途に使う。
//
// **欲しいのは値のランダムさではなく、近傍の画素どうしで誤差が打ち消し合うこと。** 画素1つぶんの
// 誤差の大きさは 0..1 の一様な列ならどれを使っても変わらず、目に見えるのは局所平均の誤差だけ
// なので、そこを小さくできる列だけが絵の質を上げる。blue noise はそれを、格子(規則的な模様として
// 見えてしまう)ではない形で満たす。
//
// **値は画素座標とずらし(tileOffset)で決まり、時間で動かない。** 動くノイズは、静止した絵ではちらつきとして目に付く。
import * as THREE from 'three/webgpu';
import { floor, ivec2, mod, round, screenCoordinate, textureLoad, vec2 } from 'three/tsl';
import type { FloatNode, Vec2Node } from './tsl-types';
import { BLUE_NOISE_TILE_BASE64, BLUE_NOISE_TILE_SIZE } from './blue-noise-tile.generated';

export class BlueNoise {
  private readonly tile: THREE.DataTexture;

  // タイルを 1 枚だけ GPU へ載せる。解放は呼び出し側が dispose で行う。tileOffset(整数の [px]、null で 0)は
  // 読む位置へ足すずらしで、どの tileShift にも同じだけ効く — 画面が整数 px 動いたときと同じく、値が画素の間で入れ替わる。
  public constructor(private readonly tileOffset: Vec2Node | null = null) {
    const bytes = Uint8Array.from(atob(BLUE_NOISE_TILE_BASE64), (c) => c.charCodeAt(0));
    this.tile = new THREE.DataTexture(
      bytes, BLUE_NOISE_TILE_SIZE, BLUE_NOISE_TILE_SIZE, THREE.RedFormat, THREE.UnsignedByteType,
    );
    this.tile.needsUpdate = true;
  }

  // いま塗っている画素の 0..1。**テクセルを整数で直に読む** — 補間もラップ設定も挟まないので、
  // 画面の向きや解像度がどうであれ、1画素が必ずタイルの1テクセルに対応する。tileShift はタイルの幅に
  // 対する 2 次元の割合で、読む位置を x と y へそれぞれずらす。同じ画素にもう 1 つ別の値が要るときは
  // (0.5, 0.5) にする。3 つ目以降の tileShift は、同じ画素で使うほかの tileShift との差が、どれもタイルの
  // 自己相関の小さい所に来る値にする。
  public atScreenPixel(tileShift: Vec2Node = vec2(0)): FloatNode {
    const pixel = floor(screenCoordinate.xy);
    const shifted = this.tileOffset === null ? pixel : pixel.add(this.tileOffset);
    const texel = mod(shifted.add(tileShift.mul(BLUE_NOISE_TILE_SIZE)), BLUE_NOISE_TILE_SIZE);
    return textureLoad(this.tile, ivec2(texel)).r;
  }

  // atScreenPixel(tileShift) と同じテクセルの 8bit の値 k(0..255)を、256 等分した層の中心 (k + 0.5) / 256 で
  // 返す。端の 0 と 1 を含まないので、端の値で退化する標本化の乱数に使う。
  public centeredAtScreenPixel(tileShift: Vec2Node = vec2(0)): FloatNode {
    return round(this.atScreenPixel(tileShift).mul(255)).add(0.5).div(256);
  }

  // 載せたタイルを解放する。
  public dispose(): void {
    this.tile.dispose();
  }
}
