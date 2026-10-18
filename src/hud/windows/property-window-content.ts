// プロパティウィンドウの本文データ構造。表示行・操作項目・関連物体・改名ハンドラをまとめる。

export type PropertyRowPresentation = 'hero' | 'major' | 'metric';

export interface PropertyRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  // 値の右に小さく淡く添える単位。省略すると単位を持たない。
  readonly unit?: string;
  // 0..1。指定すると行に細いメーターが付き、満ち幅を表す。
  readonly fill?: number;
  // Inspection Sheet 上での情報階層。省略時は通常の metric として扱う。
  // hero は対象を判断する最重要値(主読み値)、major は主要補助値。
  readonly presentation?: PropertyRowPresentation;
  // 指定すると同名の行同士が折り畳みの下にまとめられ、既定では畳まれる。
  // 描画順は rows 中でその名前が最初に現れた順。
  readonly group?: string;
}

// 操作項目の意味。target はターゲットに関する操作(第二色の面)、danger は取り消せない操作(警告面で右端へ離す)。
export type PropertyWindowItemTone = 'target' | 'danger';

export interface PropertyWindowItem<A extends string = string> {
  readonly label: string;
  readonly act: A;
  readonly shortcut?: string;
  readonly tone?: PropertyWindowItemTone;
  readonly disabled?: boolean;
  readonly keepOpen?: boolean;
}

// 対象に掛ける2値の設定(軌道線の表示など)。押すと act が選ばれ、on が現在の状態。
export interface PropertyWindowToggle<A extends string = string> {
  readonly label: string;
  readonly act: A;
  readonly on: boolean;
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
  // 題名の隣に「コード · 名称」の形で添える種別タグ。どちらも省略するとタグを持たない。
  readonly kindCode?: string;
  readonly kindLabel?: string;
  // true の対象はクリップ時に主要値だけを残した Monitor 表示へ縮退する。
  readonly monitorWhenClipped?: boolean;
  // タイトル前に添える対象種別のグリフ。省略すると添えない。
  readonly icon?: string;
  readonly rows: readonly PropertyRow[];
  readonly items: readonly PropertyWindowItem<A>[];
  // 行と操作項目のあいだに並べる2値の設定。省略すると持たない。
  readonly toggles?: readonly PropertyWindowToggle<A>[];
  // 対象に関連する物体を本文上部へ表示する。ダブルクリック/右クリックの動作はコールバックで定義する。
  readonly relatedItems?: readonly PropertyWindowRelatedItem[];
  readonly relatedTitle?: string;
  // 指定すると、タイトル横に改名ボタンが現れる。確定した新しい名前を受け取る。
  readonly onRename?: (name: string) => void;
}
