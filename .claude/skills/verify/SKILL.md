---
name: verify
description: ヘッドレス Chrome + CDP でゲームを起動・駆動し、実行時例外とエンティティ数を観測する手順。ユーザーが実行時の動作確認を明示的に求めたときだけ使う
---

# ゲームの実行時検証

**起動条件: ユーザーが実行時の動作確認・再現確認を明示的に求めたときだけ実行する。** コード変更の
既定の検証は `npm run typecheck` のみ(`src/physics/` を触ったときは `npm run test:physics` も)。

**まず `npm run smoke:browser` で足りないかを考える。** 本番ビルドを起動して60フレーム完走・HUD の
崩れ・モーダル・マップの配置と右クリックまでを通す、動く実装が既にある(`tools/browser-smoke.mjs`)。
Chrome は自力で探し、静的配信も自前で持つので、追加の環境変数なしで走る
(`SMOKE_QUERY` でステージ、`SMOKE_TOUCH=1` で仮想パッド、`CHROME_PATH` で実行ファイルを指定できる)。
以下の手順が要るのは、**そこに無い操作を与えて挙動を見たいとき**だけ。

1. `npm run dev` をバックグラウンド起動(http://localhost:8080、初回コンパイル ~30s)。
2. ヘッドレス Chrome を CDP 付きで起動し、WebSocket 経由で駆動する(puppeteer 不要。Node 20+ の
   グローバル `fetch`/`WebSocket` で足りる):
   - フラグ: `--remote-debugging-port=<port> --headless=new --enable-gpu --enable-unsafe-webgpu
     --disable-gpu-sandbox --no-sandbox --user-data-dir=<tmp> --mute-audio`
   - `http://127.0.0.1:<port>/json/list` で page ターゲットの `webSocketDebuggerUrl` を取得。
   - `Runtime.enable` 後、`Runtime.exceptionThrown` / `consoleAPICalled(type=error)` を収集する
     (これが実行時クラッシュの検出手段。main.ts の rAF ループ内の throw はここに出る)。
3. `Page.navigate` で `http://localhost:8080/?stage=1&perf=1` を開き、起動の完了を**時間でなく条件で**
   待つ: `document.documentElement.dataset.gameReady === 'true'`(例外なく60フレーム完走した印)。
   失敗時は `#fatal-error-overlay` の有無で切り分ける。
   - `?stage=N` で選択画面スキップ。`?perf=1` は負荷表示ウィンドウ(`.prop-window`)を最初から開く。
     エンティティ数(`players/enemies/bullets/casings/debris/ammos/asteroids/bases`)はその中の
     `.prop-window-row` にあり、グループのたたみ状態に関わらず DOM には出ているのでそのまま読める。
4. `Input.dispatchKeyEvent`(`rawKeyDown`/`keyUp`、`code` 必須)で入力を与える。**入力はゲーム側の
   rAF ループが取りに来て初めて効くので、結果は固定の sleep でなく条件のポーリングで待つ**:
   - Space 長押し 3s+ → スピンアップ→連射(弾・薬莢・ベルト給弾・剛体接触が全部回る)
   - KeyI / KeyW → 回転・推力(ベルト物理の擬似力・RCS)
   - KeyT / KeyM ×2 → ターゲット選択・マップモード往復
5. `Page.captureScreenshot` で証跡を保存し、収集した例外が 0 件であることを確認する。

WebGPU ヘッドレスは flaky — 失敗したら数回リトライ。マーカー(`.mk-*`)は `pointer-events:none` で、
右クリックの当たり判定はキャンバス上の座標で解かれる。狙った印を押すには、その中心座標で
`document.elementFromPoint` がキャンバスであることを先に確かめる。
