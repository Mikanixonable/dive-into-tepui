// 軌道要素と軌道要素アイコンを何に対して表示するかの選択。

// 基準の選び方。'auto' はその瞬間最も強く引いている天体、'target' は航法ターゲットを基準にする。
export type OrbitReferenceMode = 'auto' | 'earth' | 'moon' | 'target';

export class OrbitReferenceSelection {
  private _mode: OrbitReferenceMode = 'auto';

  public get mode(): OrbitReferenceMode { return this._mode; }

  // 基準の選び方を mode へ差し替える。
  public setMode(mode: OrbitReferenceMode): void {
    this._mode = mode;
  }
}
