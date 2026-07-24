
# mapMode の配線

現在マップモードと呼ばれている機能は、よく観察すると「カメラを遠くに置き、表示系を色々変える」「それと同時に、planの編集機能を有効にする」という大きく二つの責務に分解できることが分かった。
（通常の戦闘カメラでplan編集したとしても、固定カメラで戦闘したとしても、論理的には問題はない）

視点変更とノード編集は完全に別のタスクだが、フラグを共有しているのが問題。編集モードと広範囲視点モードという二つのフラグがあって、*現在の*仕様ではそれらが*たまたま*同時に切り替わっているだけ、と考えるべきだ。混乱のもとになるので名前、フラグともにも分けるべき。


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

### displayFrameFnをカメラに置くべきか（要検討）
displayFrameFnなど、「カメラと整合したクリック座標変換」について、plan-displayとmap-cameraの責務境界を要検証。
**displayFrameFnの核心データが`trajYawRef`らしい。(予測キャッシュ`trajSamples`の再計算タイミングに同期する基準角)はPlanDisplayの予測キャッシュのライフサイクルに従属する。
予測キャッシュ更新責務をtrajlineに移動したので、この辺の責務も要検証。
（現状 planSystem に `frame()` ヘルパがあり、`display.bindDisplayFrame(ephemeris, mapCamera.frameRotating)` を毎回組み立てて nodeGizmo 系のピッキングに渡している。frameRotating は mapCamera、基準角は planDisplay に分散しており、この境界の整理が上記に直結する。）

### planDisplayの移動（要検討）
bindDisplayFrameの立ち位置も要検討。こいつがカメラと一緒になっていれば解決する問題が多いんじゃないか？


## その後に着手する細部

### game.ts ↔ planSystem の右クリック中継（新規・残課題）
ノードハンドルを DOM で直接右クリックした場合だけは canvas の右クリックとして拾えない（ハンドルが canvas の子ではなく pointerdown を stopPropagation するため）。このため nodeGizmo → `planSystem.onNodeHandleRightClick` → game.ts の `dispatchMapRightClick` という中継を通している。「node-vs-focus の調停を game.ts 一箇所に集約する」ためには妥当な配線だが、DOM イベントが planSystem を一段経由して上層まで往復する形にはなっている。cameraSystem.mapMode / planSystem.editMode の分離（上記）や、外部から直接コールバックを登録できる経路の整備が進めば、この中継の要否も再検討できる。

### wireHudCallbacksの解体（部分的に前進、未完）
mapGizmo の密結合起因だった「bindGizmoCallbacks に全コールバックを束ねる」問題は解消済み。nodeGizmo のイベントは `planSystem.wireNodeGizmo()` が直接配線し、focusGizmo の onMenuFocus は cameraSystem が自前で配線するようになった（planSystem を経由しない）。

一方 wireHudCallbacks 自体はまだ残っており、HUD 由来のコールバック（duration 選択・frame トグル・focus 選択・view リセット・slider）がすべて planSystem を窓口に集約されている。外部から直接コールバック登録する経路がないと、集約された登録口がすべての窓口を必要とするために却って密結合になる、という構図は未解決。たとえば onMapFocusSelect / onMapViewReset は本来 cameraSystem 寄りの操作であり、focusGizmo と同様に cameraSystem 側で直接受けられるはず。onMenuWarpTo が simSpeedManager.startAutoWarpTo を呼ぶ中継（wireNodeGizmo 内）も同種の無駄なたらいまわしに見える。

### plan云々のmarkDirty管理をplan内に隠蔽（未解決）
外部でpublic編集→markDirtyを呼んでいる部分は、そのpublicFieldを管理しているクラスに適切なsetterを作るべきだ。「フィールド変更→整合性維持(markDirty)」のペアが呼び出し側(planSystem)に暗黙で分散している — CLAUDE.mdの「複数箇所が一定の整合性を保つことが要求されるデータ」に該当。
（現状 wireHudCallbacks 内で `display.predictDurationKey` 変更後や `mapCamera.frameRotating` トグル後に `editor.plan.markDirty()` を手で呼んでおり、依然として分散している。）

そもそもmarkDirtyを使ったplanの再計算システムが変かも。メモ再計算の仕組み……


## 番外「ツールバーstate」の中継がplan-editor.tsを不必要に経由している。

これはCtx注入と同じ問題。本質的にはsplit-map-modeの問題ではない。

`PlanSystem.updateEditing()`(plan-system.ts) は `display.predictDurationKey` / `mapCamera.frameRotating` / `display.sliderT`(→ghostLabel) / `mapCamera.focus` を1つの`toolbar`オブジェクトに組み立て、`PlanEditor.updateEditing`(plan-editor.ts) に渡す。PlanEditorはこのtoolbar引数の中身に一切関与せず、最後に`_hud.setMapToolbarState(...)`を呼ぶだけ(ノード編集ロジックとは無関係)。同様に `PlanDisplay.resolveDisplayTime()` も `predictDurationSec`/`displayTime` を呼ぶだけの中継。いずれも「plan-editor.ts経由」「plan-system.ts内で完結」という配線上の理由でしかなく、sliderT/frameRotating の置き場所が是正されれば、この中継自体が不要になる可能性が高い。


## predictDurationSec(player: Player): numberの戻り値管理が密結合
　仕様がまだよくわかってないがこいつが返すのはおかしい。（現状 planSystem.updateDisplay が `display.predictDurationSec(player)` の戻り値を mapMarkers.updateLabels に横流ししている。）




## 軌道予測とplanSystemの分離
現状の将来軌道予測（trajlineなどの実装）では、プレイヤーと天体暦しか軌道予測されていないが、ターゲットについてもプレイヤーと同等の軌道予測をするべきで、
それ以外の物体についても簡易的な（さらに大きなステップのRK4か、摂動を無視した楕円軌道近似）のシミュレーションをすべきであるという将来ビジョンがある。

将来的にこれを実装しやすするため、現在分散している軌道予測、将来状態表示の責務を切り出し、一元化し、整理しなければならない（現在それが各所に分散している）

特に、現状、軌道予測はplan-editorと密結合になってしまっているが、本来は疎結合であるべき。
軌道予測は将来の状態を雑なシミュレーションで推定し、その時にプレイヤーの軌道計画（plan）を考慮したいというもの
plan-editorはプレイヤーの軌道計画を作るためのUIであり、軌道予測の結果を参照する必要はない。
この二つはデータとしてplanを共有しているだけで、依存関係はないはずだ。
現状の、displayTimeがenvironmentにだけ反映されているのはバグ的な挙動。本来は全体的に反映すべきだが、パフォーマンス上の理由からそれが実現できていないだけ。

つまり……未来予測を保持、管理するpredictSystemみたいなのを新設し、sliderTやdurationKey、trajlineの補完と更新をまとめる。
表示しているのが現在状態なのか未来のスナップショットなのかの分岐の管理が必要
未来予測はとりあえずsimulatorとは別枠。simulatorは戦闘の判定を行うが、未来予測は軌道計算のみ。ただし将来的に共通実装は共通化すべきかもしれない。


### 軌道予測に関連する責務
- `sliderT`や`durationKey`による、予測軌道の期間調整 (hud.tsやplan-editor.ts、planSystem.tsに分散)
- planに基づいた`trajline`の生成（plan-display.ts、physics/predicate.ts）
- `displayTime`の設定、ephemerisやenvironmentSceneへの設定（plan-display.ts、plan-editor.ts、game.tsなどに分散）
- その他の（playerでもephemerisでもない）物体に関する簡易的な軌道計算（未実装。将来的に実装したい）

### plan-editorに関連する責務
- `plan`の編集
- Δvの管理

### 将来的な実装 軌道予測とシミュレーターのインターフェイスをどうにか統合したい
現状のシミュレーターも一枚岩ではなくて、死亡後はサブステップを行わない、プレイヤーと敵と弾以外には詳細な衝突判定（ステップ間衝突）を行わない、という処理になっている
楕円軌道近似を行うとか、（ターゲットのために）entityごとにシミュレーション制度を調整するとか、そういった対応をすると統合できるようになりそう。
あと、軌道予測の場合、用途的にentity配列を直接更新してしまってはまずいから、複製を取ってステップ計算…？