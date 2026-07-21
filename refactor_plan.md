# リファクタリング計画

## リファクタリング方針

大方針は、
- Game.tsのオーケストレーション層化
- 各モジュールの疎結合化と責務の整理



## todo
inputを賢くする。consumeKey機能を付ける？

enemyのbehaveはcanEnemyFireだけで制御されてしまっている。
プレイヤーの姿勢角度調整モードの自動オンオフ
プレイヤーのbehaveとhandleEdgeInputの分離？結合？updateの分離
playerのfireのロジック 冗長すぎるまだまだ簡略化できそう。
barrelとmagとroundの階層関係が分かった方がいい

## オーケストレーション配線
改善点を把握
pip-rendererが名前に反して非pipのレンダリングを管理している。
Game.updateのネストが無駄に深い。

mapに関してはまだ読めていない


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



