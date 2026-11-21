// DeferredTexture(src/render/deferred-texture.ts)の段の切替の回帰テスト。段ごとの組からの
// URL の選択、読む先が変わるものだけの取り直し、古い到着・解放後の到着の破棄、テクスチャ
// 実体の維持を、画像の取得だけ差し替えて検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { test } from '../harness';
import { DeferredTexture, TEXTURE_RESOLUTION } from '../../src/render/deferred-texture';

// ImageLoader が作る img 要素の代役。src を張られた時点で取得が始まったと見なし、
// load/error はテスト側から任意の時点で起こす。
class FakeImageElement {
  public complete = true;
  public crossOrigin?: string;
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
  public constructor(private readonly onSrc: (url: string) => void) {}

  public addEventListener(type: string, fn: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  public removeEventListener(type: string, fn: (event?: unknown) => void): void {
    const list = this.listeners.get(type);
    const index = list?.indexOf(fn) ?? -1;
    if (index !== -1) list?.splice(index, 1);
  }

  public set src(url: string) { this.onSrc(url); }

  public fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn.call(this);
  }
}

// 画像の取得を差し替える document の面。張られた src の順と、その URL へ張られた最後の
// 要素を記録する。他のテストが立てた代役を壊さないよう、元の値を戻せる。
function installImageStub(): {
  readonly requested: readonly string[];
  pending(url: string): FakeImageElement | null;
  restore(): void;
} {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.document;
  const requested: string[] = [];
  const pending = new Map<string, FakeImageElement>();
  globals.document = {
    createElementNS: () => {
      const image: FakeImageElement = new FakeImageElement((url) => {
        requested.push(url);
        pending.set(url, image);
      });
      return image;
    },
  };
  return {
    requested,
    pending: (url) => pending.get(url) ?? null,
    restore: () => { globals.document = previous; },
  };
}

// publishOne が呼ぶ initTexture だけを持つレンダラの代役。
function fakeRenderer(): { renderer: WebGPURenderer; inits: THREE.Texture[] } {
  const inits: THREE.Texture[] = [];
  return {
    renderer: { initTexture: (texture: THREE.Texture) => { inits.push(texture); } } as unknown as WebGPURenderer,
    inits,
  };
}

const URLS = { low: 'a-2048.jpg', medium: 'a-4096.jpg', high: 'a.jpg' };

export function register(): void {
  test('deferred-texture: 段ごとの組は現在の段の URL を読み、文字列は段によらず同じ', () => {
    try {
      const deferred = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      assert.equal(deferred.resolvedUrl, 'a.jpg');
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.medium);
      assert.equal(deferred.resolvedUrl, 'a-4096.jpg');
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      assert.equal(deferred.resolvedUrl, 'a-2048.jpg');
      const single = new DeferredTexture('b.jpg', THREE.SRGBColorSpace);
      for (const tier of [TEXTURE_RESOLUTION.low, TEXTURE_RESOLUTION.medium, TEXTURE_RESOLUTION.high]) {
        DeferredTexture.setResolution(tier);
        assert.equal(single.resolvedUrl, 'b.jpg');
      }
      deferred.dispose();
      single.dispose();
    } finally {
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: request は現在の段の画像を取り、投入で世代が進む', () => {
    const stub = installImageStub();
    try {
      const deferred = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      deferred.request();
      deferred.request();
      assert.deepEqual(stub.requested, ['a.jpg']);
      stub.pending('a.jpg')?.fire('load');
      const { renderer, inits } = fakeRenderer();
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 1);
      assert.equal(deferred.texture.image, stub.pending('a.jpg'));
      assert.equal(inits.length, 1);
      assert.equal(inits[0], deferred.texture);
      deferred.dispose();
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: 段を変えると読む先が変わるインスタンスだけ取り直し、同じ実体へ差し替える', () => {
    const stub = installImageStub();
    try {
      const { renderer } = fakeRenderer();
      const tiered = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      const flat = new DeferredTexture('b.jpg', THREE.SRGBColorSpace);
      tiered.request();
      flat.request();
      stub.pending('a.jpg')?.fire('load');
      stub.pending('b.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      DeferredTexture.publishOne(renderer);
      assert.equal(tiered.generation, 1);
      assert.equal(flat.generation, 1);

      const texture = tiered.texture;
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      // b.jpg は段を変えても同じ画像を読むので取り直さない。
      assert.deepEqual(stub.requested.slice(2), ['a-2048.jpg']);
      stub.pending('a-2048.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      assert.equal(tiered.generation, 2);
      assert.equal(tiered.texture, texture);
      assert.equal(tiered.texture.image, stub.pending('a-2048.jpg'));
      tiered.dispose();
      flat.dispose();
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: 取り直しの途中で段がまた変わると古い到着は捨てる', () => {
    const stub = installImageStub();
    try {
      const { renderer } = fakeRenderer();
      const deferred = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      deferred.request();
      stub.pending('a.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      const highImage = deferred.texture.image;

      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      assert.deepEqual(stub.requested, ['a.jpg', 'a-2048.jpg']);
      // 低の画像が届く前に高へ戻ると、低の取得は取り消されて届いても捨てられる。
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
      stub.pending('a-2048.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 1);
      assert.equal(deferred.texture.image, highImage);

      // あらためて低へ切り替えると取り直して差し替わる。
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      assert.deepEqual(stub.requested, ['a.jpg', 'a-2048.jpg', 'a-2048.jpg']);
      stub.pending('a-2048.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 2);
      assert.equal(deferred.texture.image, stub.pending('a-2048.jpg'));
      deferred.dispose();
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: 投入済みの URL の段へ戻るときは取り直さない', () => {
    const stub = installImageStub();
    try {
      const { renderer } = fakeRenderer();
      const deferred = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      deferred.request();
      stub.pending('a.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 1);

      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
      // a.jpg は投入済みなので取り直さない。低へ向けた取得は取り消される。
      assert.deepEqual(stub.requested, ['a.jpg', 'a-2048.jpg']);
      stub.pending('a-2048.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 1);
      deferred.dispose();
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: 同じ URL を持つ段への切替では取り直さない', () => {
    const stub = installImageStub();
    try {
      // 幅の上限が原寸と同じ段は原寸を使う画像の組。
      const urls = { low: 'm-2048.jpg', medium: 'm.jpg', high: 'm.jpg' };
      const deferred = new DeferredTexture(urls, THREE.SRGBColorSpace);
      deferred.request();
      assert.deepEqual(stub.requested, ['m.jpg']);
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.medium);
      assert.deepEqual(stub.requested, ['m.jpg']);
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      assert.deepEqual(stub.requested, ['m.jpg', 'm-2048.jpg']);
      deferred.dispose();
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: 投入待ちのまま段が変わると待ち行列から外れて取り直す', () => {
    const stub = installImageStub();
    try {
      const { renderer } = fakeRenderer();
      const deferred = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      deferred.request();
      stub.pending('a.jpg')?.fire('load');

      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      stub.pending('a-2048.jpg')?.fire('load');
      // 高の画像は投入されることなく、低の画像が1枚だけ投入される。
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 1);
      assert.equal(deferred.texture.image, stub.pending('a-2048.jpg'));
      deferred.dispose();
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });

  test('deferred-texture: dispose は取得の到着を捨て、再登録させない', () => {
    const stub = installImageStub();
    try {
      const { renderer } = fakeRenderer();
      const deferred = new DeferredTexture(URLS, THREE.SRGBColorSpace);
      deferred.request();
      deferred.dispose();
      stub.pending('a.jpg')?.fire('load');
      DeferredTexture.publishOne(renderer);
      assert.equal(deferred.generation, 0);
      // dispose 後の request は何もしない。
      deferred.request();
      assert.deepEqual(stub.requested, ['a.jpg']);
      // 段の切替でも取り直さない。
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.low);
      assert.deepEqual(stub.requested, ['a.jpg']);
    } finally {
      stub.restore();
      DeferredTexture.setResolution(TEXTURE_RESOLUTION.high);
    }
  });
}
