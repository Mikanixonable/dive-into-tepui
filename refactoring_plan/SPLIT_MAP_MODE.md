
# mapMode の配線

現在マップモードと呼ばれている機能は、よく観察すると「カメラを遠くに置き、表示系を色々変える」「それと同時に、planの編集機能を有効にする」という大きく二つの責務に分解できることが分かった。
（通常の戦闘カメラでplan編集したとしても、固定カメラで戦闘したとしても、論理的には問題はない）

視点変更とノード編集は完全に別のタスクだが、フラグを共有しているのが問題。編集モードと広範囲視点モードという二つのフラグがあって、*現在の*仕様ではそれらが*たまたま*同時に切り替わっているだけ、と考えるべきだ。混乱のもとになるので名前、フラグともにも分けるべき。


現状の責務構成
- game
  - mapModeToggler　OK　CameraとPlanの適切な動機を行う唯一のモジュール
  - cameraSystem
  　- mapMode(boolean)　NG！　CameraとPlan両方を兼ねている！
    - mapCamera
    - chaseCamera
  - planSystem
    - planGuide
    - planDisplay　Camera側に移動すべきか微妙なところ。要検討
    - planEditor
      - plan
      - mapGizmo　　NG！　CameraとPlan両方を兼ねている！ 分割！！
    - mapMarkers　　NG！　Camera側に移動するべき

### cameraSystemのmapModeフラグが二つの責務を持っている。
planSystemのeditModeフラグを持たせ、cameraSystemのmapModeフラグとは別の情報供給源とする。これらは同一のbooleanを2か所で保持しているの*ではなく*、本来独立に切り替えても各モジュールには影響がないものを、*たまたま*mapModeTogglerが同期して切り替えている、という形にするべき。

前述の通り、現状のmapModeフラグは「広範囲視点モード」と「plan編集モード」の二つの意味が重なってしまったものである。cameraSystemが持つmapModeフラグは前者の責務に関するものに限定し、後者の責務に関してはmapModeTogglerが持つものとして分離したい。現在mapModeを参照している箇所のうち、視覚的な問題はcamera.mapModeを、挙動上の問題はmapToggler.mapModeのフラグを参照する？

影響範囲がデカいうえ、（現状潰れている情報を復元するという作業になるので）機械的に置き換えできないのが難しい。
playerなどはcameraを受け取ってmapModeを参照しているが、その中にもどっちから拾うべきか個別の判断が必要だったりする。
例えばbillboard描画はどちらのカメラにしても正常に動作すべきなのでactiveCameraから拾うべき。
マップモード中は姿勢制御ができない？みたいな挙動になっているみたいだが、これはそもそも削除して問題ない挙動である可能性がある

### displayFrameFnをカメラに置くべきか（要検討）
displayFrameFnなど、「カメラと整合したクリック座標変換」について、plan-displayとmap-cameraの責務境界を要検証。
**displayFrameFnの核心データが`trajYawRef`らしい。(予測キャッシュ`trajSamples`の再計算タイミングに同期する基準角)はPlanDisplayの予測キャッシュのライフサイクルに従属する。
予測キャッシュ更新責務をtrajlineに移動したので、この辺の責務も要検証。

### mapGizmoの分割
そもそもmapGizmoが酷すぎる、軌道計画ノードをクリックしたときの表示と、mapMarkerをクリックした時の表示は全く別のUIでありながら、同じクラスとして表現されている。mapMarkerはmapCameraのフォーカス先候補であり、mapCamera寄りの責務であるのに対し、ノードクリックした時の表示はplan側の責務であるため、これが一つのモジュールになっている限り疎結合化は達成できない。直ちに是正が必要。

現状、openMenuのparamsによって二種のUIを切り替えている。そもそも別モジュールにして、呼び出し元であるplanEditorがどっちのUIを開くか選ぶという形であるべきだ。

### mapMarkersの移動
mapmarkersは、mapCameraのフォーカス先の候補であり、planというよりはmapCamera寄りの責務であるが、現状planSystemが持ってしまっている。

### planDislayの移動
bindDisplayFramenの立ち位置も要検討。こいつがカメラと一緒になっていれば解決する問題が多いんじゃないか？


## その後に着手する細部

### wireHudCallbacksの解体
mapGizmoが密結合であることの影響として、wireHudCallbacksがごちゃごちゃになっているというのがある。
上記の分割が適切に済んだ後、検査する

たとえば、ここでplanSystemはwireHudCallbacksからsimSpeedManagerの`startAutoWarpTo`を呼んでいるが、これは無駄なたらいまわしに見える。外部からmapGizmoのコールバック登録が、bindGizmoCallbacksの一か所にまとめられてしまっているのが良くない。このせいで、すべてのコールバックがplanSystemを経由してしまう。ほかのhudのコールバックについても類似の問題があるが、外部から直接コールバック登録をする経路がないと、集約された登録口がすべての窓口を必要とするために、却って密結合になる。

### plan云々のmarkDirty管理をplan内に隠蔽
外部でpublic編集→markDirtyを呼んでいる部分は、そのpublicFieldを管理しているクラスに適切なsetterを作るべきだ。「フィールド変更→整合性維持(markDirty)」のペアが呼び出し側(planSystem)に暗黙で分散している — CLAUDE.mdの「複数箇所が一定の整合性を保つことが要求されるデータ」に該当。

そもそもmarkDirtyを使ったplanの再計算システムが変かも。メモ再計算の仕組み……


## 番外「ツールバーstate」の中継がplan-editor.tsを不必要に経由している。

これはCtx注入と同じ問題。本質的にはsplit-map-modeの問題ではない。

`updateEditing()`(map-mode-system.ts:245-257)は `display.predictDurationKey` / `mapCamera.frameRotating` / `mapCamera.sliderT` / `this.focus` を1つの`toolbar`オブジェクトに組み立て、`PlanEditor.updateEditing`(plan-editor.ts:298-349)に渡す。PlanEditorはこのtoolbar引数の中身に一切関与せず、最後に`_hud.setMapToolbarState(...)`を呼ぶだけ(ノード編集ロジックとは無関係)。同様に`resolveDisplayTime()`(map-mode-system.ts:281-285)も`display.predictDurationSec`/`display.displayTime`を呼ぶだけの中継で、実体はPlanDisplayに置ける処理。いずれも「plan-editor.ts経由」「map-mode-system.ts内で完結」という配線上の理由でしかなく、Bの sliderT/frameRotating の置き場所が是正されれば、この中継自体が不要になる可能性が高い。


## predictDurationSec(player: Player): numberの戻り値管理が密結合
　仕様がまだよくわかってないがこいつが返すのはおかしい。