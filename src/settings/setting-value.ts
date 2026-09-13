// 設定1つぶんの、現在値だけを読む面。

export interface SettingValue<T> {
  // いま選ばれている値。
  readonly current: T;
}
