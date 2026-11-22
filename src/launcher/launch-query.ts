// ページの URL が起動に求めていること。location を読むのはこのモジュールだけ。

function query(): URLSearchParams {
  return new URLSearchParams(location.search);
}

// ?stage= で直接起動を求められたステージの id。無ければ null。
export function requestedStageId(): string | null {
  return query().get('stage');
}

// ?title=1 なら、再開や直接起動より優先してタイトル画面を出す。
export function forcesTitle(): boolean {
  return query().get('title') === '1';
}

// ?perf=1 なら、起動時からデバッグ情報の窓を開く。
export function opensDebugInfoAtStart(): boolean {
  return query().get('perf') === '1';
}

// ?layout-smoke が付いていれば、レイアウトのスモーク検査が駆動しているページである。
export function drivenByLayoutSmoke(): boolean {
  return query().has('layout-smoke');
}

// レイアウト検査(tools/browser-smoke)が ?layout-smoke=hud で開いたか。開いたときは描画資源を組まず、
// 描画も行わない。DOM の寸法と入力だけを見る検査で、シェーダの事前コンパイルを省くための経路。
export function layoutSmokeHudOnly(): boolean {
  return query().get('layout-smoke') === 'hud';
}
