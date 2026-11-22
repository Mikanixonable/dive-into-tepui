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

// レイアウトのスモーク検査(tools/browser-smoke)がページをどう駆動しているか。
// - 'freezable': ?layout-smoke。検査が凍結を求めたフレームだけ描画を止める。
// - 'hudOnly': ?layout-smoke=hud。描画資源を組まず、描画も行わない。DOM の寸法と入力だけを見る
//   検査で、シェーダの事前コンパイルを省くための経路。
export type LayoutSmoke = 'freezable' | 'hudOnly';

// ?layout-smoke の値が求める駆動の形。検査が駆動していないページでは null。
export function layoutSmoke(): LayoutSmoke | null {
  const value = query().get('layout-smoke');
  if (value === null) return null;
  return value === 'hud' ? 'hudOnly' : 'freezable';
}
