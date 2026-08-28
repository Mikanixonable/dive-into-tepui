// 画素ごとに固定の 0..1 の疑似乱数を、焼き込んだ blue noise タイル(tools/export-blue-noise.mjs)
// から引く器。積分の刻みをずらす、ディザを掛ける、といった「画素ごとに違う値が要る」用途に使う。
//
// **欲しいのは値のランダムさではなく、近傍の画素どうしで誤差が打ち消し合うこと。** 画素1つぶんの
// 誤差の大きさは 0..1 の一様な列ならどれを使っても変わらず、目に見えるのは局所平均の誤差だけ
// なので、そこを小さくできる列だけが絵の質を上げる。blue noise はそれを、格子(規則的な模様として
// 見えてしまう)ではない形で満たす。
//
// **画素座標だけから引くので時間で動かない。** 動くノイズは、静止した絵ではちらつきとして目に付く。
import * as THREE from 'three/webgpu';
import { floor, ivec2, mod, screenCoordinate, textureLoad } from 'three/tsl';
import type { FloatNode } from './tsl-types';
import { BLUE_NOISE_TILE_BASE64, BLUE_NOISE_TILE_SIZE } from './blue-noise-tile.generated';

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

  // 載せたタイルを解放する。
  public dispose(): void {
    this.tile.dispose();
  }
}
