// 決まったテクスチャのプール(rgba16float)から、描画ごとに結ぶ組を選べる MRT の描画先。
// 組の外のテクスチャへは書かれない(書き込みマスクは MRT の添付ごとには変えられない)。
//
// 使い方: select で組を選んでからその戻り値を setRenderTarget に渡す。RenderTarget は 1 つのまま、
// その textures を差し替えて結ぶ。three は描画パスの記述を描画先ごとにテクスチャ id の並びで覚え、寸法が
// 変わらない限り作り直さないので、組ごとの記述が 1 度だけ作られる。RenderTarget を組ごとに分けて
// テクスチャを共有してはならない — 2 つ目の初回の更新が共有テクスチャを作り直し、1 つ目の記述が
// 壊れたテクスチャを指す。MRT の出力名は結んでいる組のテクスチャ名と引き当てるので、マテリアルは
// 使う組を結んでから組む。組には名前の重ならないテクスチャを結ぶ。寸法は setSize で変える。
import * as THREE from 'three/webgpu';

export class MrtTexturePool {
  private readonly target: THREE.RenderTarget;
  // names の順に作った全テクスチャ。名前は重なってよい。
  public readonly textures: readonly THREE.Texture[];

  // names の順に全テクスチャを作る。名前が MRT の出力名になる。
  public constructor(names: readonly string[]) {
    this.target = new THREE.RenderTarget(1, 1, { count: names.length, depthBuffer: false, samples: 0 });
    this.textures = [...this.target.textures];
    for (const [index, texture] of this.textures.entries()) {
      texture.name = names[index]!;
      texture.format = THREE.RGBAFormat;
      texture.type = THREE.HalfFloatType;
    }
  }

  // textures だけを、その順で結んだ描画先を返す。textures はこのプールのテクスチャ。
  public select(textures: readonly THREE.Texture[]): THREE.RenderTarget {
    this.target.textures = [...textures];
    return this.target;
  }

  // 全テクスチャの寸法を変える。結んでいない組のテクスチャも、次に結んだときに新しい寸法で作り直される。
  public setSize(width: number, height: number): void {
    if (this.target.width === width && this.target.height === height) return;
    for (const texture of this.textures) {
      // 描画先のテクスチャの image は寸法だけを持つ。
      const image = texture.image as { width: number; height: number };
      image.width = width;
      image.height = height;
      texture.needsUpdate = true;
    }
    this.target.setSize(width, height);
  }

  // 全テクスチャと描画先の GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    for (const texture of this.textures) texture.dispose();
  }
}
