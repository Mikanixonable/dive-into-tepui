// 画像の取得を遅らせたテクスチャ。実体は生成時からあるので、マテリアルもシェーダグラフも
// 画像を待たずに組める。取得は DOM を要するため、生成だけなら DOM の無い環境でも通る。
// 届いた画像の GPU への投入は全インスタンス共通の待ち行列を通り、publishOne が1回に1枚だけ
// 進める — まとめて投入すると、その1回で JS スレッドが数百 ms 止まる。
//
// 段ごとの画像の組を持つインスタンスは、TEXTURE_RESOLUTION の現在の段に応じた画像を読む。
// setResolution で段が変わると、要求済みのインスタンスのうち読む先が変わるものだけ画像を
// 取り直し、届き次第同じテクスチャの画像を差し替える — 読み手が掴んでいる実体は動かさない。
import * as THREE from 'three/webgpu';

// 異方性フィルタ段数。斜めから見た球面の縞立ちを抑える。
const ANISOTROPY = 16;

// 描画設定「テクスチャ解像度」の段。値は保存された設定を読む鍵なので、段を足しても
// 既存の値は動かさない。
export const TEXTURE_RESOLUTION = { low: 0, medium: 1, high: 2 } as const;
export type TextureResolution = (typeof TEXTURE_RESOLUTION)[keyof typeof TEXTURE_RESOLUTION];

// テクスチャ解像度の段ごとの画像 URL。
export type TextureUrls = Readonly<{ low: string; medium: string; high: string }>;

// 画像の取得先。文字列は段によらず同じ画像を読み、段ごとの組は現在の段の画像を読む。
export type TextureUrlSource = string | TextureUrls;

export class DeferredTexture {
  private static readonly ready: DeferredTexture[] = [];
  // 画像を要求済みの存命中のインスタンス。段の切替で差し替え対象を捜すために追う。
  private static readonly live = new Set<DeferredTexture>();
  // 現在の段。初期値は高 — 設定が届くまでは従来どおり原寸を読む。
  private static resolution: TextureResolution = TEXTURE_RESOLUTION.high;

  // 画像が届くまで空のままのテクスチャ。読み手はこの実体を掴んでよい。
  public readonly texture: THREE.Texture;
  private requested = false;
  private queued = false;
  private disposed = false;
  private image: HTMLImageElement | null = null;
  private publishedGeneration = 0;
  // 取得を変えるたびに進める番号。違う番号の取得の到着は捨てる。
  private fetchSerial = 0;
  // 取得中か投入待ちの画像が来た URL。
  private pendingUrl: string | null = null;
  // テクスチャへ投入済みの画像が来た URL。
  private publishedUrl: string | null = null;

  // colorSpace は届く画像の色空間。
  public constructor(
    private readonly url: TextureUrlSource, colorSpace: string,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.texture = new THREE.Texture();
    this.texture.colorSpace = colorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  // GPUへ公開した画像の世代。画像の到着前と到着後を、表示時刻とは別の入力として扱う。
  // 同じ時刻でも入力が変わった読み手は、自分のキャッシュを作り直せる。
  public get generation(): number { return this.publishedGeneration; }

  // 現在の段で読む画像の URL。段ごとの組を持つときだけ段に応じて変わる。
  public get resolvedUrl(): string {
    const url = this.url;
    if (typeof url === 'string') return url;
    switch (DeferredTexture.resolution) {
      case TEXTURE_RESOLUTION.low: return url.low;
      case TEXTURE_RESOLUTION.medium: return url.medium;
      default: return url.high;
    }
  }

  // 描画設定「テクスチャ解像度」の段を全インスタンスへ適用する。段が変わったら、
  // 要求済みのうち読む先が変わるインスタンスだけ画像を取り直す。
  public static setResolution(resolution: TextureResolution): void {
    if (resolution === DeferredTexture.resolution) return;
    DeferredTexture.resolution = resolution;
    for (const instance of DeferredTexture.live) instance.retarget();
  }

  // 画像の取得を始める。取得は非同期なので、届くまではテクスチャが空のまま読まれる。
  public request(): void {
    if (this.requested || this.disposed) return;
    this.requested = true;
    DeferredTexture.live.add(this);
    this.fetch(this.resolvedUrl);
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
    DeferredTexture.live.delete(this);
    this.discardPending();
    this.texture.dispose();
  }

  // url の画像の取得を始める。取り消された取得や解放済みインスタンスへの到着は捨てる。
  private fetch(url: string): void {
    const serial = ++this.fetchSerial;
    this.pendingUrl = url;
    // DOMを持たない検査環境や、loaderの同期的な生成失敗でもfallbackを維持する。
    try {
      new THREE.ImageLoader().load(url, (image) => {
        if (this.disposed || serial !== this.fetchSerial) return;

        this.image = image;
        this.queued = true;
        DeferredTexture.ready.push(this);
      }, undefined, (error) => {
        if (this.disposed || serial !== this.fetchSerial) return;
        this.pendingUrl = null;
        this.onError?.(error);
      });
    } catch (error: unknown) {
      if (!this.disposed) {
        this.pendingUrl = null;
        this.onError?.(error);
      }
    }
  }

  // 段の変更へ追従する。現在の段の画像が取得済みなら取り直さず、取得中か投入待ちの
  // 別段の画像があれば捨ててから、読む先が変わるものだけ取り直す。
  private retarget(): void {
    if (this.disposed) return;
    const next = this.resolvedUrl;
    if (this.pendingUrl === next) return;
    // 別の段から戻ってきて投入済みの画像がその段のものなら、その画像のまま。
    if (this.publishedUrl === next) {
      this.discardPending();
      return;
    }
    this.discardPending();
    this.fetch(next);
  }

  // 取得中・投入待ちの画像を捨てる。テクスチャへ投入済みの画像は残る。
  private discardPending(): void {
    this.fetchSerial += 1;
    this.pendingUrl = null;
    this.image = null;
    if (this.queued) {
      const index = DeferredTexture.ready.indexOf(this);
      if (index !== -1) DeferredTexture.ready.splice(index, 1);
      this.queued = false;
    }
  }

  // 届いている画像をテクスチャへ載せる。まだ届いていないか解放済みなら偽を返す。
  private publish(): boolean {
    if (this.disposed || this.image === null) return false;

    // 画像を張り替えるときは GPU 側の実体を一度捨てる。寸法の違う画像は既存の
    // GPU テクスチャへ収まらないので、initTexture に作り直させる。
    if (this.publishedUrl !== null) this.texture.dispose();
    this.texture.image = this.image;
    this.texture.needsUpdate = true;
    this.publishedGeneration += 1;
    this.publishedUrl = this.pendingUrl;
    this.pendingUrl = null;
    this.image = null;
    return true;
  }
}
