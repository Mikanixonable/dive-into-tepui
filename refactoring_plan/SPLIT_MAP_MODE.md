
# mapMode の配線

現在マップモードと呼ばれている機能は、よく観察すると「カメラを遠くに置き、表示系を色々変える」「それと同時に、planの編集機能を有効にする」という大きく二つの責務に分解できることが分かった。
（通常の戦闘カメラでplan編集したとしても、固定カメラで戦闘したとしても、論理的には問題はない）

視点変更とノード編集は完全に別のタスクだが、フラグを共有しているのが問題。編集モードと広範囲視点モードという二つのフラグがあって、*現在の*仕様ではそれらが*たまたま*同時に切り替わっているだけ、と考えるべきだ。混乱のもとになるので名前、フラグともにも分けるべき。


現状
- game
  - planGuide
  - mapModesystem
    - planDisplay
    - planEditor
      - plan


### mapModeTogglerじゃなくてcameraSystemがmapModeフラグを持っている
修正したいが、影響範囲がデカい。playerなどはcameraを受け取ってmapModeを参照している。現在mapModeを参照している箇所のうち、視覚的な問題はcamera.mapModeを、挙動上の問題はmapTogglerのフラグを参照する…？

プレイヤーの挙動に関しては……
例えばbillboard描画はどちらのカメラにしても正常に動作すべきなのでactiveCameraから拾うべき。
マップモード中は姿勢制御ができない？みたいな挙動になっているみたいだが、これはそもそも削除して問題ない挙動である可能性がある

広範囲視点に関するものは、cameraSystemが持つ。

### mapModeSystemとplan-editorの責務境界
mapModeSystemがマップモード中の挙動だけ管理するというのが怪しくなってきていて、実態はマップモードについてはtogglerやcameraSystemに掃き出されたので、planに関するファサードになるべき。そうすると、plan-guideが逆に漏れていることになる。

### planDislayとmapCameraの責務境界
mapmarkersの立ち位置も検討　こいつは実質的に、mapCameraのフォーカス先の候補
bindDisplayFramenの立ち位置も要検討。こいつがカメラと一緒になっていれば解決する問題が多いんじゃないか？


## F. 噴射ガイドの凍結解除(planGuide.clearActiveTarget)が2つの別経路を持つ。
- [X]キー: `MapModeSystem.clearPlanByKey` → コンストラクタ注入の`onPlanCleared`コールバック → `planGuide.clearActiveTarget()`
- [M]キー: `game.ts`の`handleEdgePress`が`mapModeSystem.toggleMap(...)`の直後に`this.planGuide.clearActiveTarget()`を**mapModeSystemを介さず直接**呼ぶ(game.ts:254)

同じ「Plan操作後にplanGuideの凍結目標を破棄する」後始末が、片方はコールバック経由、片方はgame.tsからの直接呼び出しという別の配線になっている。

## mapModeからsimSpeedManagerへの介入（要検討）
MapModeSystemはsimSpeedManagerの`startAutoWarpTo`/`cancelAutoWarp`という公開APIのみを呼んでいるが、そもそもmapModeの責務なのか？ plan-guideとかの責務である可能性はないか？
mapModeを編集と表示の二軸に大きく分割するとしたときにどっちに属すか、を考えたい

### displayFrameFnをカメラに置くべきか（要検討）
displayFrameFnなど、「カメラと整合したクリック座標変換」について、plan-displayとmap-cameraの責務境界を要検証。
**displayFrameFnの核心データが`trajYawRef`らしい。(予測キャッシュ`trajSamples`の再計算タイミングに同期する基準角)はPlanDisplayの予測キャッシュのライフサイクルに従属する。
予測キャッシュ更新責務をtrajlineに移動したので、この辺の責務も要検証。

### plan云々のmarkDirty管理をplan内に隠蔽
外部でpublic編集→markDirtyを呼んでいる部分は、そのpublicFieldを管理しているクラスに適切なsetterを作るべきだ。「フィールド変更→整合性維持(markDirty)」のペアが呼び出し側(MapModeSystem)に暗黙で分散している — CLAUDE.mdの「複数箇所が一定の整合性を保つことが要求されるデータ」に該当。
`wireHudCallbacks()`(map-mode-system.ts:66-88)の5つのコールバックのうち、`onMapViewReset`だけが`mapCamera.reset()`という正規メソッド経由。残り4つは
- `onDurationSelect`: `this.display.predictDurationKey = key` に加えて `plan.markDirty()` を呼び出し側で毎回セットで書く
- `onFrameToggle`: `this.mapCamera.frameRotating = !this.mapCamera.frameRotating` + `plan.markDirty()`
- `onMapFocusSelect`: `this.mapCamera.pan.set(0, 0, 0)` (Vector3を直接操作)
- `onSliderChange`: `this.mapCamera.sliderT = t`





## 番外「ツールバーstate」の中継がplan-editor.tsを不必要に経由している。

これはCtx注入と同じ問題。本質的にはsplit-map-modeの問題ではない。

`updateEditing()`(map-mode-system.ts:245-257)は `display.predictDurationKey` / `mapCamera.frameRotating` / `mapCamera.sliderT` / `this.focus` を1つの`toolbar`オブジェクトに組み立て、`PlanEditor.updateEditing`(plan-editor.ts:298-349)に渡す。PlanEditorはこのtoolbar引数の中身に一切関与せず、最後に`_hud.setMapToolbarState(...)`を呼ぶだけ(ノード編集ロジックとは無関係)。同様に`resolveDisplayTime()`(map-mode-system.ts:281-285)も`display.predictDurationSec`/`display.displayTime`を呼ぶだけの中継で、実体はPlanDisplayに置ける処理。いずれも「plan-editor.ts経由」「map-mode-system.ts内で完結」という配線上の理由でしかなく、Bの sliderT/frameRotating の置き場所が是正されれば、この中継自体が不要になる可能性が高い。


## predictDurationSec(player: Player): numberの戻り値管理が密結合
　仕様がまだよくわかってないがこいつが返すのはおかしい。