# リファクタリング計画

## 現状分析

- 現状の依存関係、責務を整理し、関連性順に整理して、modules.mdファイルにまとめる。そのモジュールの実装の細部ではなく、何を責務としていて、どこからimportされているかをまとめる。

## リファクタリング案

Shipをinterfaceからclassに変更
  PlayerとEnemyはそれぞれShipを継承するclassにする。

OrbitEntity型の利用拡大
  AttやRadiusもここに含める。
  使用していないフィールドはコンストラクタがデフォルトで埋める。

  Bullet/PlasmaBullet/Casing/MagPickup/DebrisPieceなどはOrbitObjectを継承するクラス型にする。

CollisionEntityを廃止、OrbitEntityをそのまま利用する形にする。
  beltの当たり判定もcollisionが担当している？　そうしたら...OrbitObjectを継承しbeltIndexを保持するBeltSection型を追加し、
  これをBeltPhysicsとcollision.tsの受け渡しに使う。`writeBackBeltCollisionState`の配線は最悪なので修正。
  `isBelt`は`has beltIndex`なり`.constructor.name`なりで判定すれば置き換え可能。
  belt.tsのロジックが変わらないように注意！

Game.tsにおける配列の統合はいきなりやらない。いきなりやると、あとから区別のためのfilter処理を入れることになり、無駄
とりあえず、Bullet/PlasmaBulletは統合してよさそう？



ポリモーフィズムの利用
  render-dynamics.ts内のパターン統一？


- 責務の分散と再結合
  - 肥大しているモジュールがないか検査。あるいは、無駄に分割されていて統合した方がむしろ良いモジュールがないか検査。

MarkersCtxを2つに分割。MarkersCtxをMarkerCtx（マーカー用）とHudPanelCtx（パネル用）に分割するのは確実な改善。
hud.tsの責務が大きすぎる。hud/panel.tsを新設し、HudPanelCtxを利用する依存箇所をそこに集約。
markerManagerとmarkerSystemの責務を分離する。

OrbitLineUpdateCtxでEnvironmentSystem全体を渡している箇所は{ sunPhase0, moonPhase0 }という最小インターフェイスに変えるだけで良い。HudSyncCtxはctxを直接下位システムに渡すだけなら存在意義が薄い。



Ctxの最小化

- ctx注入パターンの見直し。過剰な依存関係の解消。
ctx注入パターンはそもそも密結合を生む原因に見える。
まず、必要以上のctxを注入してしまっていないかを確認する。
そもそも、幅広いctxが必要になる時点で、責務分離が不十分である可能性が高い。現在挙がっているメソッドを確認し、ctxのなかで必要としているフィールドが異なるメソッド群が一つのモジュールに混在していないかを確認する。

ctxか微妙に重複し、微妙に異なるフィールドを持つ場合、そもそも責務の方が密結合になっていて、過剰にフィールドを要求しないようなより最適な分割が可能なのではないか。

どうしてもgameのcontextすべてが必要である場合、contextを渡すのではなくgameを渡すべきじゃないか（そのようなパターンは乱用すべきではないが）

- この時点で重複実装、類似実装を再度検査し、適切に共通化する。
  - 完全に共通していなくても、単一責務について、類似の実装が複数個所にあるべきでない。適切な方の責務にのみ残し、不適切な方からは削除する。多少のバリエーションであれば引数で吸収する。