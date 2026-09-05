// 画像の取得を遅らせたテクスチャ。実体は生成時からあるので、マテリアルもシェーダグラフも
// 画像を待たずに組める。取得は DOM を要するため、生成だけなら DOM の無い環境でも通る。
// 届いた画像の GPU への投入は全インスタンス共通の待ち行列を通り、publishOne が1回に1枚だけ
// 進める — まとめて投入すると、その1回で JS スレッドが数百 ms 止まる。
import * as THREE from 'three/webgpu';

// 異方性フィルタ段数。斜めから見た球面の縞立ちを抑える。
const ANISOTROPY = 16;

export class DeferredTexture {
  private static readonly ready: DeferredTexture[] = [];

  // 画像が届くまで空のままのテクスチャ。読み手はこの実体を掴んでよい。
  public readonly texture: THREE.Texture;
  private requested = false;
  private queued = false;
  private disposed = false;
  private image: HTMLImageElement | null = null;

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
      if (this.disposed) return;

      this.image = image;
      this.queued = true;
      DeferredTexture.ready.push(this);
    });
  }

  // 待ち行列の先頭1枚を GPU へ投入する。空なら何もしない。
  public static publishOne(renderer: THREE.WebGPURenderer): void {
    const deferredTexture = DeferredTexture.ready.shift();
    if (deferredTexture === undefined) return;

    deferredTexture.queued = false;
    if (deferredTexture.publish()) renderer.initTexture(deferredTexture.texture);
  }

  // 1フレーム明け渡してから待ち行列の先頭1枚を投入する。空なら待たずに戻る。
  public static async publishOneNextFrame(renderer: THREE.WebGPURenderer): Promise<void> {
    if (DeferredTexture.ready.length === 0) return;

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    DeferredTexture.publishOne(renderer);
  }

  // テクスチャを解放する。取得が飛んでいる最中でも呼んでよい。
  public dispose(): void {
    this.disposed = true;
    this.image = null;
    if (this.queued) {
      const index = DeferredTexture.ready.indexOf(this);
      if (index !== -1) DeferredTexture.ready.splice(index, 1);
      this.queued = false;
    }
    this.texture.dispose();
  }

  // 届いている画像をテクスチャへ載せる。まだ届いていないか解放済みなら偽を返す。
  private publish(): boolean {
    if (this.disposed || this.image === null) return false;

    this.texture.image = this.image;
    this.texture.needsUpdate = true;
    this.image = null;
    return true;
  }
}
