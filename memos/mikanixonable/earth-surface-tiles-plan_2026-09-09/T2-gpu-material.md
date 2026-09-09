# T2: 実GPU境界とEarth materialを完成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

Three.js/WebGPUのDataArrayTextureとTSL materialをEarthSurfaceへ接続し、非対応環境では全球baseへ固定する。

## 実装範囲

1. 色DataArrayTexture、地形DataArrayTexture、RGBA8ページ表を作るadapterを追加する。
   Three.jsの内部APIを使う場合はadapter内だけへ隔離し、他のrender/game層へ漏らさない。
2. 起動時に2D array、最低128層、色のsRGB処理、Float16地形のlinear処理を検査する。
3. TSLは楕円体法線、共通地理UV、ページ表Nearest、現在/親層、
   sRGB線形化、色・法線・roughness混合、normalNodeの順で接続する。
4. R=255または未取得は全球baseへ戻す。模式図スタイルでは地形層を読まず幾何法線を使う。
5. 色と地形の両方が揃ったGPU層だけをフレーム境界で公開する。
6. fake backendで同一frame公開、非公開層だけの書込み、dispose後の遅着拒否を固定する。
7. mipmapを必須にしない。タイルLODと親子fadeでちらつき・境界を確認する。
8. GPU追加メモリと隣接差はmetricsへ記録する。128MiB超過や2/255超過だけでコードゲートを落とさない。

## 完了条件

- fake backendの全テストが通る。
- WebGPU非対応・能力不足時にDataArrayTextureを作らず、全球baseへ固定する。
- 実ブラウザで起動できる場合、z0/z1、親子fade、極、日付変更線、非一様半軸、自転0/90/180度を撮影する。
- 実ブラウザを起動できない場合は、base-onlyと実GPU未実施を分けて記録する。
