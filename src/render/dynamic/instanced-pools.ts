// InstancedMesh で描く種別ごとのプールの束をまとめ、1フレームぶんの積み始め・積み終えを一括する。
// 束は種別のクラスで引く。

// 1種別ぶんの InstancedPool の束。種別ごとに1つのクラスとして定義する。
export interface InstancedPoolSet {
  // このフレームぶんを積み始める。
  beginFrame(): void;
  // このフレームぶんを積み終える。
  endFrame(): void;
  // 束が持つ InstancedMesh を解放する。
  dispose(): void;
}

export class InstancedPools {
  // sets は種別ごとの束。同じクラスの束は1つまで。
  public constructor(private readonly sets: readonly InstancedPoolSet[]) {}

  // kind のクラスで作られた束を返す。登録されていなければ例外を投げる。
  public get<T extends InstancedPoolSet>(kind: abstract new (...args: never[]) => T): T {
    const set = this.sets.find((s): s is T => s instanceof kind);
    if (set === undefined) throw new Error(`${kind.name} の束が登録されていない`);
    return set;
  }

  // このフレームぶんを積み始める。積む前に1度だけ呼ぶ。
  public beginFrame(): void {
    for (const set of this.sets) set.beginFrame();
  }

  // このフレームぶんを積み終える。積み終えたら1度だけ呼ぶ。
  public endFrame(): void {
    for (const set of this.sets) set.endFrame();
  }

  // 全束の InstancedMesh を解放する。
  public dispose(): void {
    for (const set of this.sets) set.dispose();
  }
}
