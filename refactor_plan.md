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

### cameraの管理、targetの管理、その他Gameが直接持つフィールドの縮小
Gameがcameraを保持してcameraSystemにctxとして渡しているけども、cameraSystemが普通に持っておくべきじゃないか？
targetをGameが保持しているが、Targteterが持っているlockedTargetと一致しているのであれば、それのgetterなどで情報を供給すべきだ。
同様のパターンがほかにもありそう。ctx注入しているが、そもそもそこでしか使っていないものは、ctx注入を経由せず、そのモジュールがフィールドを持つべきだ。ctx注入パターンへの依存を最小化すべき。

### gameのrenderとupdateの責務の分割
renderFrameという関数がありながら、そこではpipの描画のみを行っていて、renderはupdateに含まれているのは実態と名前が一致していない。

### dom操作の分散（優先度低）
touch.tsやmapgismo.tsなど、hud以外の部分にdom操作が分散している。これが直接悪いとは言い切れないが…

### gameとstageDirectorの責務の分割
初期化とかもstageDirectorに委譲できる。

### playerのbeltの配線が長い。
player.beltCollisionSections
-> player.fire.collisionSections
-> player.fire.belt.collisionSections

applyBeltCollisions
-> player.fire.applyCollisionSections
-> player.fire.belt.applyCollisionSections

### thermalって本当にgameが持つべき？
Playerの温度を管理しているのなら、Playerが持つべきではないか？実態把握から

### syncRenderEarthだのsyncRenderStarBodyだのは、syncRenderEnvironmentにまとめる。
これはEnvironmentにひとまとめに実装し、Gamからたらい回しは最短に留めるべき

### beltとplayer.fireの責務境界
collisionSectionsとapplyCollisionSectionsをたらい回しにするだけのハンドラが存在する。beltを公開して直接操作すべきだ。
そもそも関数名が何をしているのか分かりにくい。applyCollisionSectionsは、beltのVerlet物理演算を行う関数であるが、名前からは想像できない。だいたい公開する必要性があるのか？

combat/belt.tsをplayer/belt-physics.tsに移動、改名する。
player.fireが直接beltGroupを持っているが、これは責務が良くない。belt.tsを新設し、責務を分割するべきか？

### combatの責務の分割
気が付いたらcombatがマンモスクラスになっている……
読めたもんじゃないので責務の分析から着手し、どう疎結合化するかを検討する。

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