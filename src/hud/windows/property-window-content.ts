// プロパティウィンドウに差し出す本文の型。行・操作項目・関連物体・改名のどれを出すかは
// 呼び出し側が決め、窓はそれを並べるだけ。

export interface PropertyRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  // 立てると「詳細」トグルの下に畳まれ、既定では隠れる。
  readonly collapsible?: boolean;
  // 指定すると同名の行同士がグループ見出しの下にまとめられ、既定では畳まれる。
  // 描画順は rows 中でその名前が最初に現れた順。
  readonly group?: string;
}

export interface PropertyWindowItem<A extends string = string> {
  readonly label: string;
  readonly act: A;
  readonly shortcut?: string;
  readonly selected?: boolean;
  readonly keepOpen?: boolean;
}

export interface PropertyWindowRelatedItem {
  readonly id: string;
  readonly label: string;
  readonly onFocus: () => void;
  readonly onContextMenu: (clientX: number, clientY: number) => void;
}

export interface PropertyWindowContent<A extends string = string> {
  readonly title: string;
  readonly subtitle?: string;
  // タイトル前に添える対象種別のグリフ。省略すると添えない。
  readonly icon?: string;
  readonly rows: readonly PropertyRow[];
  readonly items: readonly PropertyWindowItem<A>[];
  // 対象に関連する物体を本文上部へ表示する。ダブルクリック/右クリックの動作は呼び出し側が持つ。
  readonly relatedItems?: readonly PropertyWindowRelatedItem[];
  readonly relatedTitle?: string;
  // 指定すると、タイトル横に改名ボタンが現れる。確定した新しい名前を受け取る。
  readonly onRename?: (name: string) => void;
}
