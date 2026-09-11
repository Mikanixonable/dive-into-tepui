// ランを跨いで残る設定1つぶんの、ランから見た口。現在値を読み、ランの中で編集した結果を書き戻す。
export interface RunSetting<T> {
  // いま選ばれている値。
  readonly current: T;
  // 編集した値へ差し替える。
  set(value: T): void;
}
