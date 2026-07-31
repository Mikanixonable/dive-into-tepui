
# mapMode の配線
かつてMapModeと呼ばれていた機能は、よく観察すると「カメラを遠くに置き、表示系を色々変える」「planの編集機能を有効にする」「スライダーを動かし、将来の軌道予測を表示する」という大きく三つの責務に分解できることが分かった。
（通常の戦闘カメラでplan編集したとしても、固定カメラで戦闘したとしても、論理的には問題はない）

これらが*現在の*仕様ではそれらが*たまたま*同時に切り替わっているだけ、と考えるべきだ。混乱のもとになるので名前、フラグともにも分けるべき。

現在、最初のカメラの問題は比較的適切に、cameraSystemに切り出された（いくつかの残課題はあるが）。しかし、残り二つがまだplanSystemに混在しており、planSystemの責務が広すぎる。これを整理する必要がある。

現状の責務構成
- game
  - dispatchMapPointer / dispatchMapRightClick　OK(新設)　「node が消費しなかった右クリックだけ focus 選択へフォールする」調停を上層に集約。二つのギズモは互いを参照しない
  - mapModeToggler　OK　CameraとPlanを同期して開閉する唯一のモジュール（node/focus 両メニューの closeMenu もここが行う）
  - cameraSystem
  　- mapMode(boolean)　OK(分離済)　「広範囲視点モード」の責務のみ。描画/視点側の判定に使う
    - mapCamera
    - chaseCamera
    - mapMarkers　OK(移設済)　フォーカス候補ラベル。planSystem から cameraSystem へ移した
    - focusGizmo　OK(分割済)　ラベルのフォーカス選択メニュー。onMenuFocus は cameraSystem 内で mapCamera.focus へ直結
  - planSystem
    - editMode(boolean)　OK(新設)　「plan編集モード」の責務のみ。入力/挙動側の判定に使う
    - planGuide
    - planDisplay　Camera側に移動すべきか微妙なところ。要検討
    - planEditor
      - plan
      - nodeGizmo　OK(分割済)　ノード編集ギズモ(ハンドル・Δvアーム・ノードメニュー)のみ

（node-gizmo / focus-gizmo が共有する汎用ポップアップ context-menu は、plan・camera どちらの専有物でもないため中立地点の map-mode/ に残置。map-mode/ に残るのは map-mode-toggler と context-menu のみ）

## cameraSystem分離に伴う残課題

### displayFrameFnをカメラに置くべきか（要検討）
displayFrameFnなど、「カメラと整合したクリック座標変換」について、plan-displayとmap-cameraの責務境界を要検証。
**displayFrameFnの核心データが`trajYawRef`らしい。(予測キャッシュ`trajSamples`の再計算タイミングに同期する基準角)はPlanDisplayの予測キャッシュのライフサイクルに従属する。
予測キャッシュ更新責務をtrajlineに移動したので、この辺の責務も要検証。
（現状 planSystem に `frame()` ヘルパがあり、`display.bindDisplayFrame(ephemeris, mapCamera.frameRotating)` を毎回組み立てて nodeGizmo 系のピッキングに渡している。frameRotating は mapCamera、基準角は planDisplay に分散しており、この境界の整理が上記に直結する。）

### planDisplayの移動（要検討）
bindDisplayFrameの立ち位置も要検討。こいつがカメラと一緒になっていれば解決する問題が多いんじゃないか？

### game.ts ↔ planSystem の右クリック中継（新規・残課題）
ノードハンドルを DOM で直接右クリックした場合だけは canvas の右クリックとして拾えない（ハンドルが canvas の子ではなく pointerdown を stopPropagation するため）。このため nodeGizmo → `planSystem.onNodeHandleRightClick` → game.ts の `dispatchMapRightClick` という中継を通している。「node-vs-focus の調停を game.ts 一箇所に集約する」ためには妥当な配線だが、DOM イベントが planSystem を一段経由して上層まで往復する形にはなっている。cameraSystem.mapMode / planSystem.editMode の分離（上記）や、外部から直接コールバックを登録できる経路の整備が進めば、この中継の要否も再検討できる。

### wireHudCallbacksの解体（部分的に前進、未完）
mapGizmo の密結合起因だった「bindGizmoCallbacks に全コールバックを束ねる」問題は解消済み。nodeGizmo のイベントは `planSystem.wireNodeGizmo()` が直接配線し、focusGizmo の onMenuFocus は cameraSystem が自前で配線するようになった（planSystem を経由しない）。

一方 wireHudCallbacks 自体はまだ残っており、HUD 由来のコールバック（duration 選択・frame トグル・focus 選択・view リセット・slider）がすべて planSystem を窓口に集約されている。外部から直接コールバック登録する経路がないと、集約された登録口がすべての窓口を必要とするために却って密結合になる、という構図は未解決。たとえば onMapFocusSelect / onMapViewReset は本来 cameraSystem 寄りの操作であり、focusGizmo と同様に cameraSystem 側で直接受けられるはず。onMenuWarpTo が simSpeedManager.startAutoWarpTo を呼ぶ中継（wireNodeGizmo 内）も同種の無駄なたらいまわしに見える。

### plan云々のmarkDirty管理をplan内に隠蔽（未解決）
外部でpublic編集→markDirtyを呼んでいる部分は、そのpublicFieldを管理しているクラスに適切なsetterを作るべき……と思ったが、実際は使用箇所が少ないので、いったん容認。markDirtyという関数名と、フラグ管理は気に食わないが…（メモを削除して必要時に再計算、というのがいいだろう）

### 「ツールバーstate」の中継がplan-editor.tsを不必要に経由している。
これはCtx注入と同じ問題。本質的にはsplit-map-modeの問題ではない。
`PlanSystem.updateEditing()`(plan-system.ts) は `display.predictDurationKey` / `mapCamera.frameRotating` / `display.sliderT`(→ghostLabel) / `mapCamera.focus` を1つの`toolbar`オブジェクトに組み立て、`PlanEditor.updateEditing`(plan-editor.ts) に渡す。PlanEditorはこのtoolbar引数の中身に一切関与せず、最後に`_hud.setMapToolbarState(...)`を呼ぶだけ(ノード編集ロジックとは無関係)。同様に `PlanDisplay.resolveDisplayTime()` も `predictDurationSec`/`displayTime` を呼ぶだけの中継。いずれも「plan-editor.ts経由」「plan-system.ts内で完結」という配線上の理由でしかなく、sliderT/frameRotating の置き場所が是正されれば、この中継自体が不要になる可能性が高い。


## 軌道予測（predictSystem）とplanSystemの分離
別文書（SPLIT_PREDICT_SYSTEM.md）で計画