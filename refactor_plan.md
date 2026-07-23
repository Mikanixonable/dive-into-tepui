# リファクタリング計画

## リファクタリング方針

大方針は、
- Game.tsのオーケストレーション層化
- 各モジュールの疎結合化と責務の整理



## todo

enemyのbehaveはcanEnemyFireだけで制御されてしまっている。
playerのfireのロジック まだまだ簡略化できそう、修正もできそう。
dtとsimDtの混在の是正
姿勢制御を角加速度記憶、自動加算に分離したい

## marker周りの可読性向上
現状ここの可読性が著しく低いので是正する

markerManagerとmarkerSystemはともに複数のmarkerを扱うモジュールになっている。

MarkerForGameはMarkerManagerを包含し、用途を限定してる。
MarkerManagerはMarkerForGameのほかにも各所で利用されている。

各所で利用されているMarkermanagerのインスタンスは、_hud.markerManagerと同一であることが多そう。そもそも_hud.markerManagerを直接参照している箇所もあるみたいだ。例外はあるだろうか
MarkerManagerをhudが持つのは正しい責務だろうか
MarkerManagerはSVGで表示しているため、作るだけでは表示できず、親要素に結び付ける必要がある………？それはどこで実装されている？　にしてもHUDが持つべきじゃない気がするが…
複数のインスタンスがあるとして、親要素は共通？

markerForGameを分散させるうえで懸念がある。例えば敵のマーカーの管理をEnemy.tsの責務とする、などとして、markerManagerをhudやsfxのように参照共有するパターンを採用するとして、移動先がない場合、あるいは複数個所の情報を統合して表示しなければならない場合には配線が増える。markerForGameの核private関数について、配線を増やさずに分散できるかどうか評価してほしい

方針としては、まずmarkerとhudを密結合にすべきでないので、Markermanagerの真インスタンスはhudに持たせるのではなく、Gameとかに持たせるべきだ。
MarkerForGameが集約するんだかしないんだかはっきりしてほしい。たぶん集約しない方が今後のためになるだろうけど……

## mapMode の配線
マップモード、軌道計画モードの責務が広い。関連する仕様には

- カメラを遠くに置いて表示する
- プランを更新、編集する
- simSpeedのの自動調整
- マップモードを開いたり閉じたりする
- マップGizmo(Hudの一種)を更新する
- マップモード中でのみ見ることができるラベル（マーカー）を更新する

などの責務があって、これが複数のファイル(map-mode-system.ts、plan-guide.ts、map-gismo.ts、map-camera.ts、game.tsなど)に混在している。ファイル数的には分割されているように見えるが、分割位置が悪い。

mapModeSystemがマップモード関連のファサードになることになっていたが、それが自己目的化していて、他ファイルに切り出されたはずの責務をまだ持っている。simSpeedManagerやMapCameraは概念的にだいぶ遠いのに、その参照を共有されて保持して勝手に弄っている。しかも、cameraSystemが持ってるMapModeフラグを弄れないので、結局戻り値でGame.tsに返している。

### 調査
まず、SPEC.md、と実コードを参照して、先述の関連する仕様、挙動がほかにあるかを調査する（ここで関連するというのは、関数名で判断するのではなく、インスタンスの受け渡し方などから実質的な使用パターンを検証すること）。

次に、それぞれの責務がどのファイルに存在するかを調べる。
怪しいのは、mapCamera、plan/フォルダ以下、map-mode/フォルダ以下、mapCamera、simSpeedManager
ファイル名から想像できる責務とに正しい責務をしている部分は問題ないが、より適切なファイルが存在する場合、行単位で責務外の処理を行っていないか注目する。

#### 調査結果(2026-07時点のコードを実査)

SPEC.md 11章には「カメラ切替・軌道比較・ノード配置編集・確定実行・自動ワープ・達成判定」が書かれているのみで、コード側に現れている責務(Δv微調整のfineAttitude連動、太陽回転系表示、フォーカス対象選択など)はSPEC.mdに明文化されていない実装詳細。SPEC.mdからは新たな隠れ責務は見つからず、以下はすべて実コードの参照パターン(インスタンス保持・直接代入)から検証したもの。

**A. plan.ts / plan-guide.ts / plan-editor.ts / map-gizmo.ts / map-markers.ts はファイル名どおりの責務にほぼ収まっている。**
- `plan.ts`: ノード列+予測キャッシュの唯一の正データ。良好。
- `plan-guide.ts`: 戦闘ビュー側の実施・達成判定。マップモードの有無に依存しない設計が徹底されており良好。
- `map-gizmo.ts`: DOM/pointerイベントのみ。ゲームロジックへの依存なし。良好。
- `map-markers.ts`: フォーカス候補ラベルの算出とMarkerManagerへの反映のみ。MapCameraへの参照を持たず、必要な値(origin/simTime/duration/sliderT)を毎回引数で受けるだけ — 後述Bと対照的に模範的な配線。

**C. MapModeSystemがMapCamera/PlanDisplayのフィールドへ直接代入する「たらい回し」配線。**
`wireHudCallbacks()`(map-mode-system.ts:66-88)の5つのコールバックのうち、`onMapViewReset`だけが`mapCamera.reset()`という正規メソッド経由。残り4つは
- `onDurationSelect`: `this.display.predictDurationKey = key` に加えて `plan.markDirty()` を呼び出し側で毎回セットで書く
- `onFrameToggle`: `this.mapCamera.frameRotating = !this.mapCamera.frameRotating` + `plan.markDirty()`
- `onMapFocusSelect`: `this.mapCamera.pan.set(0, 0, 0)` (Vector3を直接操作)
- `onSliderChange`: `this.mapCamera.sliderT = t`

のように、他クラスのpublicフィールドへ直接代入している。MapCamera/PlanDisplay側にセッターが用意されておらず、「フィールド変更→整合性維持(markDirty)」のペアが呼び出し側(MapModeSystem)に暗黙で分散している — CLAUDE.mdの「複数箇所が一定の整合性を保つことが要求されるデータ」に該当。

**D. 「ツールバーstate」の中継がplan-editor.tsを不必要に経由している。**
`updateEditing()`(map-mode-system.ts:245-257)は `display.predictDurationKey` / `mapCamera.frameRotating` / `mapCamera.sliderT` / `this.focus` を1つの`toolbar`オブジェクトに組み立て、`PlanEditor.updateEditing`(plan-editor.ts:298-349)に渡す。PlanEditorはこのtoolbar引数の中身に一切関与せず、最後に`_hud.setMapToolbarState(...)`を呼ぶだけ(ノード編集ロジックとは無関係)。同様に`resolveDisplayTime()`(map-mode-system.ts:281-285)も`display.predictDurationSec`/`display.displayTime`を呼ぶだけの中継で、実体はPlanDisplayに置ける処理。いずれも「plan-editor.ts経由」「map-mode-system.ts内で完結」という配線上の理由でしかなく、Bの sliderT/frameRotating の置き場所が是正されれば、この中継自体が不要になる可能性が高い。



**F. 噴射ガイドの凍結解除(planGuide.clearActiveTarget)が2つの別経路を持つ。**
- [X]キー: `MapModeSystem.clearPlanByKey` → コンストラクタ注入の`onPlanCleared`コールバック → `planGuide.clearActiveTarget()`
- [M]キー: `game.ts`の`handleEdgePress`が`mapModeSystem.toggleMap(...)`の直後に`this.planGuide.clearActiveTarget()`を**mapModeSystemを介さず直接**呼ぶ(game.ts:254)

同じ「Plan操作後にplanGuideの凍結目標を破棄する」後始末が、片方はコールバック経由、片方はgame.tsからの直接呼び出しという別の配線になっている。

**G. simSpeedManagerへの参照保持は、B/Cと比べれば軽微。**
MapModeSystemはsimSpeedManagerの`startAutoWarpTo`/`cancelAutoWarp`という公開APIのみを呼んでおり(内部フィールドへの直接代入はない)、クラス冒頭のコメントでも「シミュレーション速度そのものの管理はSimSpeedManagerが別途持つ」と明記され、意図的にスコープを絞ってある。参照を持ち回している点は概念的な距離はあるものの、B(フィールド直接代入)ほど深刻ではない。

これらを踏まえると、以下の改善案のうち「MapCameraへの操作をmap-camera.tsへ移動する」は、sliderT/frameRotatingについては誤り(そもそもMapCameraの責務ではない)。移動先はPlan/PlanDisplay側にすべき。

### displayFrameFnをカメラに置くべきか
displayFrameFnなど、「カメラと整合したクリック座標変換」について、plan-displayとmap-cameraの責務境界を要検証。

- **displayFrameFn(PlanDisplay.toDisplayFrame)はCameraSystem/MapCameraへ移さない。** projectFnが`camera.matrixWorldInverse`/`projectionMatrix`という「カメラでなければ計算できない」値を使うのに対し、displayFrameFnはカメラ行列を一切使わず、核心データ`trajYawRef`(予測キャッシュ`trajSamples`の再計算タイミングに同期する基準角)はPlanDisplayの予測キャッシュのライフサイクルに従属する。移すとカメラがPlanの内部事情(予測再計算タイミング)を知る、現状と逆方向の依存が生まれる。実装はPlanDisplayに残し、facadeが`mapCamera.frameRotating`という1個のboolean経由で橋渡しする現状の形が妥当。

### plan云々のmarkDirty管理をplan内に隠蔽
外部でpublic編集→markDirtyを呼んでいる部分は、そのpublicFieldを管理しているクラスに適切なsetterを作るべきだ。

### planの保持をeditorの責務にすべき？
editorが最新のplan（currentPlan）を公開し、plan-guideとかはそれを参照するのが自然な実装。

## callback登録の密結合
wireHudCallbackを解体したい……gameのwireHudCallbacksもそうだが、hudとの密結合があって配線が汚い。どうにかしたい……
hudがそもそもマンモスクラスである可能性がある。要調査。

（現状map-gizmoやpanelがそうであるように？）、hudを意味的まとまりごとにgameHud、mapHudなどに分割し、それぞれにwireCallbacks関数を持たせるのがよいかもしれない。


## orbitLineの集約 vs 分散
分散させるんだか集中させるんだかが曖昧。

生成した後から色を変えることに対応していないので、ターゲット切り替え時にはEnemyのorbitLineを非表示にして代わりにtargetを表示して…という処理になっている。orbitLineの描画ごとに色（マテリアル）を指定するようにすれば改善するのでは。

orbitLineごとにlineBasicMaterialが再生成されている。パフォーマンスに悪い。外部がマテリアルを保持するべきなんだけどどこの責務にしたものか（gameが持つのは険しいからrender/内の定数参照？）


### markerの集約 vs 分散
ここまでを踏まえて、MarkerManagerの利用パターンを調査してほしい。

インスタンスは全部でいくつ作られるのか
_hud.markerManager以外にインスタンスはあるのか
どこでどのように使用されているのか
SVGをdomtreeに紐づける実装はどこにあるのか
hudとの責務結合強度はどの程度か。
他の場所に置くとしたらどこに置くのがいいか
MarkerForGameに集約するバターンと、各所が直接MarkerManagerに配線するよう分散するパターンと、どっちに統一すべきか
分散する場合、どういった経路で参照共有注入すべきか


### handleFrameとupdateの責務の違いが特にない。

### updateとsyncの分離が徹底されていない。
updateは論理値の更新。syncはTHREE.jsのオブジェクトの更新。renderは描画のみ。
カメラなどがupdateと同じ関数でTHREE.jsを更新してしまっている。

### この時点で重複実装、類似実装を再度検査し、適切に共通化する。
重複実装、類似実装
過剰責務（モジュールや関数が長すぎる）
不適切な責務（この処理はこの関数にあるべきでない。この関数はこのモジュールにあるべきでない）
無駄なハンドリング（たらいまわしだけの一行関数など）
不適切な命名

markerCtxもこれ以上まとめるのは厳しいか？責務境界の方に問題がある可能性

### 命名が悪い
無駄にsystemとつけているものがある。意味があるか（system抜きの命名だと衝突するのか、systemと呼ばれているものに共通の性質はあるのか）調査

### render/内に集約して書かれているメッシュビルダー（優先度低）
各entityの責務であるべきかも。せめて、メッシュの生成、ロードはrender/の責務で、それを呼ぶのはentityの責務とするか（外部注入ではなく）

EnvironmentSceneとEphemerisSystemは、扱うものは近いのに計算と描画なので分離されている。統合するのとしないのとどっちが良いか。EphemerisSystemを親として、EnvironmentSceneを子とするような構造化がいいのか？

## 不要なクロージャ注入
ctxと似て、脱却すべきデザインパターンなのかもしれない。updateで注入するとしたら、デリゲートではなく、クラスメソッドを持つインスタンスを注入すべきではないか。（コンストラクタで注入するのは推奨しない。参照共有は壊れやすいため）

**H. getExternalStateはctx注入パターンからの逸脱。**
Ctx注入パターンと同様、このようなクロージャ解決も滅ぼすべきである。

getExternalStateとかダメそう


## 雑多な修正点

### mapModeTogglerじゃなくてcameraSystemがmapModeフラグを持っている
修正したいが、影響範囲がデカい。playerなどはcameraを受け取ってmapModeを参照している。現在mapModeを参照している箇所のうち、視覚的な問題はcamera.mapModeを、挙動上の問題はmapTogglerのフラグを参照する…？

### hudの責務過多？
まだよく読めていないが、パネルや情報のまとまりごとにモジュールを分割できないか？

### rcsEffectのcomputeRcsTauとThrottleの重複実装。
throttleが計算済みの出力を公開し、rcsEffectはそれを参照するだけにすべき。

### beltPhysicsとbeltSectionの変換処理の見直し
beltPhysicsにbeltSection[]を「書き込む」という処理をしていて、ステートフルで良くない（メモリ効率はいいかもしれないが気にするほどじゃないはず）
beltPhysicsからbeltSection[]への変換と逆変換ということにシ、逆変換においては新規オブジェクトとして作るべきでは？

### const.tsの解体（優先度低）
一か所で使用されている定数はそのモジュールの責務である可能性が高い。モジュールの分割がある程度進み、責務が明確になった段階で、const.tsの解体を行う。

### hud、sfx注入パターンのなかで今後必要なくなる可能性が高いものを分離

### sfxとbgmの分離（優先度低）

### 引数整理
playerとplayer.status.rを両方受け取っているとか、そういう無駄をなくしたい。特に引数が多い奴。

### inputを綺麗に書き直す

### 通常カメラのnearfarが未定義
適切な値を設定する
