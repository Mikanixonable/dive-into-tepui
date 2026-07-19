---
name: verify
description: ヘッドレス Chrome + CDP でゲームを起動・駆動し、実行時例外とエンティティ数を観測する手順
---

# ゲームの実行時検証

1. `npm run dev` をバックグラウンド起動(http://localhost:8080、初回コンパイル ~30s)。
2. ヘッドレス Chrome を CDP 付きで起動し、WebSocket 経由で駆動する(puppeteer 不要。Node 20+ の
   グローバル `fetch`/`WebSocket` で足りる):
   - フラグ: `--remote-debugging-port=<port> --headless=new --enable-gpu --enable-unsafe-webgpu
     --disable-gpu-sandbox --no-sandbox --user-data-dir=<tmp> --mute-audio`
   - `http://127.0.0.1:<port>/json/list` で page ターゲットの `webSocketDebuggerUrl` を取得。
   - `Runtime.enable` 後、`Runtime.exceptionThrown` / `consoleAPICalled(type=error)` を収集する
     (これが実行時クラッシュの検出手段。main.ts の rAF ループ内の throw はここに出る)。
3. `Page.navigate` で `http://localhost:8080/?stage=1&perf=1` を開き、WebGPU 初期化を ~12s 待つ。
   - `?stage=N` で選択画面スキップ、`?perf=1` で左上にエンティティ数
     (`enemies/bullets/casings/debris`)が DOM 表示される — これを `Runtime.evaluate` で読む。
4. `Input.dispatchKeyEvent`(`rawKeyDown`/`keyUp`、`code` 必須)で入力を与える:
   - Space 長押し 3s+ → スピンアップ→連射(弾・薬莢・ベルト給弾・剛体接触が全部回る)
   - KeyI / KeyW → 回転・推力(ベルト物理の擬似力・RCS)
   - Tab / KeyM ×2 → ターゲット選択・マップモード往復
5. `Page.captureScreenshot` で証跡を保存し、収集した例外が 0 件であることを確認する。

動作するドライバスクリプトの雛形はセッションの scratchpad に `drive.mjs` として作った実績がある
(このスキルの手順をそのまま実装したもの)。WebGPU ヘッドレスは flaky — 失敗したら数回リトライ。
