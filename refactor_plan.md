# リファクタリング計画

## 現状分析

- 現状の依存関係、責務を整理し、関連性順に整理して、modules.mdファイルにまとめる。そのモジュールの実装の細部ではなく、何を責務としていて、どこからimportされているかをまとめる。

- 責務の分散と再結合
  - 肥大しているモジュールがないか検査。あるいは、無駄に分割されていて統合した方がむしろ良いモジュールがないか検査。

怪しいモジュール：
game.ts
const.ts
stage-director.ts
combat.ts
belt.ts

## リファクタリング方針

大方針は、
- Game.tsのオーケストレーション層化
- 各モジュールの疎結合化と責務の整理
- ctx注入パターンの根絶。

### playerにおけるたらいまわし配線を改善（優先度高）
throttleへのたらいまわしが残っている。
GameのhandleEdgeInputの分岐処理のうち、playerに関与するものをplayerのbehaveに移動する。behaveは既にinputを受け取っているので移行は難しくないはず。その結果公開する必要のなくなったたらいまわしはplayerフォルダの中で完結させる

### combatの責務の分割（優先度高）
気が付いたらcombatがマンモスクラスになっている……以下の方針で分割する。

敵AI -> enemy.tsのEnemyクラスにbehave関数を作り、敵の行動ロジックを移動する。ちょうどplayerのbehaveに対応する形になる。behaveの呼び出しはとりあえずgameが行う。
弾の高度な衝突判定 -> hit.tsを新設し、切り出す。
spawnDebris, spawnFlashなどの比較的些細なエフェクトスポーン処理 -> effects-system.tsに集約実装する。
プレイヤーの弾の発射 -> playerのplayer-fire.tsに実装。薬莢の排出エフェクトはeffects-systemある関数をplayer-fire.tsから呼ぶ。
機体喪失時のエフェクト処理（`destroyShip`） -> destroyEffect関数をShipに共通実装、あるいはEnemyとPlayerそれぞれに実装

敵の集計、勝敗判定 -> これこそがcombatの責務である。

この分割の結果、combatCtxがモジュールに対して過剰な規模になっていることが明らかである。「便利なまとまり」とするのではなく、各モジュールが必要な情報だけを受け取るように改善する。

### gameとstageDirectorの責務の分割
初期化、敵のスポーンロジックをstageDirectorに委譲できる。
stageDirectorはstageごとの処理の分岐を引き受けているはずだが、コードのパターンが一定していなくて保守性が悪い。

### cameraの管理　現状をよく調査する
Gameがcameraを保持してcameraSystemにctxとして渡しているけども、cameraSystemかchaseCameraが普通に持っておくべきじゃないか？
実態調査
　Game.cameraとGame.ActiveCameraは違って、Game.cameraはCombatCameraと呼ばれていて、mapModeの時にはactiveCameraはmapModeに応じてGame.cameraとmapMode.mapView.cameraで切り替わる。chase:ChaseCameraは、名前に反して、THREE.PerspectiveCameraは保持していない。Game.cameraを外部から受け取って更新している。

### render、update、sync系の関数の命名の不統一
three.jsのrender関数は、すでに出来上がったsceneとcameraを受け取って描画するものである。その意味合いからすると、sceneの構築、更新を行う関数をrenderと呼ぶのは不適切である。論理データの更新を行う関数はupdate、メッシュなどをsceneに登録する関数をbuild、すでに登録されたメッシュなどの座標を論理データに整合させる関数をsyncと呼ぶことで統一する。renderは実際にthree.jsのrenderを呼んでいる関数に限定する。

updateの中ではthree.tsオブジェクトの更新を行わないことを徹底すべき？。sync系関数の中でのみ行うべきかも

### beltとplayer.fireの責務境界（優先度低）
player.fireが直接beltGroupを持っているが、これは責務が良くない。player/belt.tsを新設し、責務を分割するべきかも？
薬莢の追加登録がここに来ることで肥大化していることが予想される。実態を把握してから行う。

### dom操作の分散（優先度低）
touch.tsやmapgismo.tsなど、hud以外の部分にdom操作が分散している。これが直接悪いとは言い切れないが…

### この時点で重複実装、類似実装を再度検査し、適切に共通化する。
重複実装の検査にLLMは役に立たないということが分かった。人力で頑張る…

## ctxの縮小と解体
現在コードのいたるところで利用されているcontext注入パターンは、時間をかけて滅ぼすべきものである。必要な情報すべてを丸投げするというのは、必要な情報が少なくなるように責務を分割しなければならないことを隠蔽してしまう。徹底して排除するべき。

ctx注入パターンはそもそも密結合を生む原因に見える。ctxをそのまま他のモジュールに受け渡したりして転用しているのは論外。
Paramsと書かれているものも同様

以下はあらかたのリファクタリングが済んでから行う。

必要以上のctxを注入してしまっていないかを確認する。

そもそも、幅広いctxが必要になる時点で、責務分離が不十分である可能性が高い。現在挙がっているメソッドを確認し、ctxのなかで必要としているフィールドが異なるメソッド群が一つのモジュールに混在していないかを確認する。

ctxか微妙に重複し、微妙に異なるフィールドを持つ場合、そもそも責務の方が密結合になっていて、過剰にフィールドを要求しないようなより最適な分割が可能なのではないか。

どうしてもgameのcontextすべてが必要である場合、contextを渡すのではなくgameまたはsimulatorを渡すべきじゃないか（そのようなパターンは乱用すべきではないが）

## const.tsの解体（優先度低）
一か所で使用されている定数はそのモジュールの責務である可能性が高い。モジュールの分割がある程度進み、責務が明確になった段階で、const.tsの解体を行う。

### orbitLineの管理
なぜこれでorbitLineが表示されるのかわからない……