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

### 改善案
map-mode-toggler.tsを新設し、mapModeSystemからマップモードの開閉に関わる処理を移動する。plan、simSpeedmanager、mapCameraの参照が必要な部分は、都度引数として注入を受けるようにする。_hudやplan、editorが必要な部分も、引数で注入を受ける。map-mode-togglerはインスタンスを直接game.tsが持つ。
cameraSystemがmapModeフラグを持っているが、これは影響範囲が広いので変更しない。mapModetogglerはapModeフラグを保持せず、与えられた参照からmapModeをトグルするだけである。

mapModeSystemから、mapCameraの操作に関する部分を、map-camera.tsに移動する。


## callback登録の密結合
wireHudCallbackを解体したい……gameのwireHudCallbacksもそうだが、hudとの密結合があって配線が汚い。どうにかしたい……
hudがそもそもマンモスクラスである可能性がある。要調査。

（現状map-gizmoやpanelがそうであるように？）、hudを意味的まとまりごとにgameHud、mapHudなどに分割し、それぞれにwireCallbacks関数を持たせるのがよいかもしれない。


## orbitLineの配線が悪い
軌道要素を再計算していたりする。

「副産物を返す関数」を作るべきじゃない。副作用のあるvoid型（成否をbooleanで返すくらいならよいが）の関数と、副作用がなく返り値が意味を持つ関数を分けるべき。

orbitLineごとにlineBasicMaterialが再生成されている。

---

ここまでを踏まえて、MarkerManagerの利用パターンを調査してほしい。

インスタンスは全部でいくつ作られるのか
_hud.markerManager以外にインスタンスはあるのか
どこでどのように使用されているのか
SVGをdomtreeに紐づける実装はどこにあるのか
hudとの責務結合強度はどの程度か。
他の場所に置くとしたらどこに置くのがいいか
MarkerForGameに集約するバターンと、各所が直接MarkerManagerに配線するよう分散するパターンと、どっちに統一すべきか
分散する場合、どういった経路で参照共有注入すべきか


## オーケストレーション配線
改善点を把握
Game.updateのネストが無駄に深い。
cameaのupadteがupdateなのかsyncなのか曖昧
mapに関してはまだ読めていない

mapModeSystem, hud, marker, planあたりはまだかなり責務境界がはっきりしていない。


## 責務把握
現状のコードを参照し、refactor_instruction.mdの責務分割の手順を実行し、調査結果を新規mdファイルに報告してください
特に調査してほしいのが、markerCtxとmarkers.tsが密結合だがupdateMarkersを一括ファサードにするのをやめることで疎結合にできないか
pip-rendererの独立性、map-mode-systemとplanとmap-cameraの結合関係。
Game.ts内にいくつにも分散して書かれているper-frame処理の

## pip-windowのupdateとsyncの分離できるか、調査検討。
その他にも全然updateとsyncの配線が整ってないとこある。

### この時点で重複実装、類似実装を再度検査し、適切に共通化する。
重複実装、類似実装
過剰責務（モジュールや関数が長すぎる）
不適切な責務（この処理はこの関数にあるべきでない。この関数はこのモジュールにあるべきでない）
無駄なハンドリング（たらいまわしだけの一行関数など）
不適切な命名

markerCtxもこれ以上まとめるのは厳しいか？責務境界の方に問題がある可能性


## const.tsの解体（優先度低）
一か所で使用されている定数はそのモジュールの責務である可能性が高い。モジュールの分割がある程度進み、責務が明確になった段階で、const.tsの解体を行う。

## hud、sfx注入パターンのなかで今後必要なくなる可能性が高いものを分離

## sfxとbgmの分離（優先度低）

### 命名が悪い
無駄にsystemとつけているものがある。意味があるか（system抜きの命名だと衝突するのか、systemと呼ばれているものに共通の性質はあるのか）調査

### render/内に集約して書かれているメッシュビルダー（優先度低）
各entityの責務であるべきかも。せめて、メッシュの生成、ロードはrender/の責務で、それを呼ぶのはentityの責務とするか（外部注入ではなく）

EnvironmentSceneとEphemerisSystemは、扱うものは近いのに計算と描画なので分離されている。統合するのとしないのとどっちが良いか。EphemerisSystemを親として、EnvironmentSceneを子とするような構造化がいいのか？

### dom操作の分散（優先度低）
touch.tsやmapgismo.tsなど、hud以外の部分にdom操作が分散している。これが直接悪いとは言い切れないが…

### rcsEffectやthrustEffectはplayer.thrustと実質的に密結合（重複実装）

## beltPhysicsとbeltSectionの変換処理の見直し
beltPhysicsにbeltSection[]を「書き込む」という処理をしているが、ステートフルで良くない
beltPhysicsからbeltSection[]への変換と逆変換ということにシ、逆変換においては新規オブジェクトとして作るべきでは？

## 不要なデリゲート注入
実はデリゲートもctxと似て、脱却すべきデザインパターンなのかもしれない。updateで注入するとしたら、デリゲートではなく、クラスメソッドを持つインスタンスを注入すべきではないか。（コンストラクタで注入するのは推奨しない。参照共有は壊れやすいため）

getExternalStateとかダメそう


updateFireStateの引数が多すぎる。
playerではなくship型で受け取ってるし


waveManagerが利用しているWaveEncounterConfigはupdateで毎回注入を受けていますが、結局定数値です。これらの値をコンストラクタで受け取ってWaveManagerクラスのフィールドにすべきです。configにひとまとめにする必要もありません。

inputを綺麗に書き直す

通常カメラのnearfarが未定義