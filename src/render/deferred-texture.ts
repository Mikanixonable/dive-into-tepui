// 画像の取得を遅らせたテクスチャ。実体は生成時からあるので、マテリアルもシェーダグラフも
// 画像を待たずに組める。取得は DOM を要するため、生成だけなら DOM の無い環境でも通る。
import * as THREE from 'three/webgpu';

// 異方性フィルタ段数。斜めから見た球面の縞立ちを抑える。
const ANISOTROPY = 16;

export class DeferredTexture {
  // 画像が届くまで空のままのテクスチャ。読み手はこの実体を掴んでよい。
  public readonly texture: THREE.Texture;
  private requested = false;

  // colorSpace は届く画像の色空間。
  public constructor(private readonly url: string, colorSpace: string) {
    this.texture = new THREE.Texture();
    this.texture.colorSpace = colorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  // 画像の取得を始める。取得は非同期なので、届くまではテクスチャが空のまま読まれる。
  public request(): void {
    if (this.requested) return;
    this.requested = true;
    new THREE.ImageLoader().load(this.url, (image) => {
      this.texture.image = image;
      this.texture.needsUpdate = true;
    });
  }

  // テクスチャを解放する。取得が飛んでいる最中でも呼んでよい。
  public dispose(): void {
    this.texture.dispose();
  }
}
