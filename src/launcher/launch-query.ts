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
