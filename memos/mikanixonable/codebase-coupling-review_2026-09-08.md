# 会話の整理とコードベース調査

## 調査スナップショット

- HEAD: dc9c5292
- 調査時の作業ツリー: clean
- 対象: 現在のコード。仕様書や既存メモから現在の実装を推定していない。
- このメモは調査結果と修正案であり、コードの現状を説明する正本ではない。記述とコードが食い違った場合はコードを優先する。

## 1. 会話の要約

会話では、次の論点が連続して扱われていた。

1. generics をほとんど見ないという印象と、短い型定義ファイルを一箇所へ汎化・統合できないかという疑問。
2. 依存関係を減らす計画なのに import 行が増えることへの違和感。短いファイルを分割することが凝集度の改善になっているのかという疑問。
3. 物理シミュレーション、天体モデル、レンダリング、DOM/HUD の境界がどこにあるのかという確認。
4. DOM 側がシミュレーションの情報を広く必要とするため、万能インターフェイスや密結合が生じているという認識。
5. celestial は不変な天体情報と時刻問い合わせを持つので表示コンポーネント側へ移せるのではないか、React によってビューを宣言的にできるのではないかという提案。
6. React は状態管理と場面変更を整理するための手段なのか、Three.js はそのまま使うのか、という設計判断。

要約すると、中心課題は React の採否そのものではなく、ゲーム全体を知る Game と、シミュレーション・表示・DOM の接合点が広すぎて、変更の影響範囲を推論しにくいことにある。

## 2. 規模と依存グラフの実測

| 範囲 | ファイル数 | 行数 |
| --- | ---: | ---: |
| src の TypeScript | 523 | 77,601 |
| src/game | 262 | 44,555 |
| src/render | 109 | 15,199 |
| src/physics | 48 | 6,862 |
| tests の TypeScript | 100 | 13,222 |

静的な相対 import を解決した内部依存 edge は 3,074 本だった。これは type-only import も含むため、実行時の結合度そのものではないが、構造の集中箇所を見つける指標にはなる。

主なハブは次の通り。

- 被参照数: math/vec3.ts 152、physics/celestial-motion.ts 86、physics/kinematic-state.ts 82、game/celestial/celestial-system.ts 65、render/tsl-types.ts 52。
- 依存先数: game/player/player.ts 67、game/game.ts 53、game/dynamic/dynamic-entity/base.ts 48、game/dynamic/dynamic-entity/dynamic-entity.ts 45、game/celestial/celestial-system.ts 42。
- 層間 edge: game → game 1,381、game → physics 355、game → math 180、game → render 169、game → hud 123、render → game 13。

したがって、コードベースは「型ファイルが増えたこと」だけが問題になる規模ではない。主な認知負荷は、game 層に機能と配線が集中し、Game が多くの下位モジュールを組み立てていることから生じている。

## 3. 現在のフレーム構造

main.ts のフレーム処理は、50–78 行の次の順序になっている。

~~~text
requestAnimationFrame
└─ Game.update
   ├─ 入力処理
   ├─ activeStage.update
   ├─ DynamicSystem.update
   │  └─ Simulator.advance
   ├─ displayWindow の解決
   ├─ DynamicSystem.requestHistoryDuration
   ├─ Predictor.update
   ├─ CameraSystem.update
   └─ pointer input
└─ Game.sync
   ├─ CelestialSystem.sync
   ├─ CelestialSystem.bakeClouds
   ├─ DynamicSystem.sync
   ├─ target / plan / entity line / view の同期
   └─ Hud.syncPanels(view, game)
└─ Game.render
   └─ RenderPipeline.render
~~~

この順序は src/game/game.ts:403–456、516–589 にある。表示窓は update 中に解決され、過去履歴の要求、予測の表示期間、カメラ更新へ渡される。つまり、表示設定が計算資源へ影響するという会話の認識は、値の流れとして正しい。

ただし、値の流れが相互に関係することと、モジュールが相互に import しなければならないことは別である。表示窓や履歴長を明示的な入力値として渡せば、値の関係を保ったままソース上の境界を狭くできる。

## 4. 論点ごとの妥当性

| 論点 | 判定 | 調査結果 |
| --- | --- | --- |
| generics はほとんど使っていない | 不正確 | 59 個の generic 宣言が 27 ファイルにある。Deque、TimeRing、座標系・時刻系の型など、意味のある使用が複数ある。 |
| 同じ型定義は generic にして一箇所へ集約すべき | 条件付きで妥当 | 再利用する同型がある場合は有効。ただし現在の generic の多くは再利用より型安全性や要素型の保持が目的で、統合の基準にはならない。 |
| 短い型ファイルは依存先と同じファイルへ統合すべき | 一部妥当 | 1 consumer は見直し候補だが、行数ではなく責務・ライフサイクル・テスト境界・語彙の共有範囲で判断すべき。 |
| 依存削減なのに import が増える | 観測として妥当 | 抽出により import 数が増えることはある。import 数の増減だけでは凝集度や変更影響を評価できない。 |
| 物理と DOM は疎結合 | 下位層では妥当、game 層では不十分 | physics/math と DOM/Three は実際に疎。ただし DynamicSystem と HUD、Three、天体系は広く接続している。 |
| DOM 側が万能 interface を必要としている | 妥当 | game/hud 内の 12 ファイルが Game 型を直接参照し、Hud.syncPanels が複数パネルへ Game 全体を渡している。 |
| celestial はほぼ immutable で表示側へ移せる | 一部妥当 | CelestialMotion の時刻問い合わせと KinematicState はその性質に近い。一方 CelestialSystem/CelestialEntity は表示資源、可視性、設定、破棄まで持つ。 |
| celestial を React コンポーネントへ移せる | 現状のままでは不妥当 | celestial は dynamic、predictor、camera、orbit analysis からも問い合わせられるシミュレーションサービスであり、表示専用ではない。 |
| React でビューを宣言的にすべき | 問題認識は妥当、解決策は未確定 | DOM の手動移動・同期はある。React は DOM 投影には使えるが、Game 依存やシミュレーション境界を自動では解決しない。 |
| Three.js も React 化する | 採用根拠なし | 現在の Three.js 部分は WebGPU、TSL、雲、天体表示、GPU resource lifecycle を扱う。DOM の課題だけから renderer 移行を正当化できない。 |

### 4.1 generics と branded/phantom type

現在のコードには、会話に出た Deque<T> だけでなく、次のような実例がある。

- math/deque.ts の Deque<T>: 要素型を保った汎用コンテナ。
- physics/time-ring.ts の TimeRing<T>: 時刻キャッシュの値型を保つ。
- math/spatial-grid.ts、math/hierarchical-spatial-grid.ts: 空間構造に格納する要素型を保つ。
- hud の Pulldown<T>、SegmentedControl<T>、TabBar<T>、PropertyWindow<A>: UI の値や action 型を保つ。
- physics/time/index.ts の CalendarDate<S>、JulianDate<S>: UTC、TT、TDB の時刻系を混同させない。
- physics/kinematic-state.ts の KinematicState<F>: 座標の原点・供給源を型札として保持する。FramedVec3<F> と __frame/__originOf は phantom type に近い。

特に時刻系と座標系の generic は、同じ形の値を一つの型へ押し込むためではなく、物理的に混ぜてはいけない値をコンパイル時に区別するために存在する。ここを「型定義を減らすための generic」と見なして統合すると、型安全性を失う。

### 4.2 短い型ファイルの分類

短いこと自体は統合理由にならない。実際に次のような違いがある。

- game/dynamic/dynamic-entity/entity-kind.ts は 17 行だが、動的エンティティの union と上限値を共有する語彙で、24 ファイルから参照される。
- game/celestial/celestial-entity/celestial-entity-def.ts は 13 行だが、physics の CelestialKind を表示用 CelestialClass へ変換する境界を持つ。単なる型袋ではない。
- render/tsl-types.ts は 22 行だが、TSL の Node/Uniform 型の共通語彙で、約 58 ファイルが参照する。
- game/dynamic/dynamic-entity/parts.ts は複数の part schema と ExtractPart<TType> をまとめており、型の共通文脈を持つ。
- game/hud/map-scale.ts は小さく、map-scale-badge と同じ機能に属するため統合候補にはなる。ただし DOM から独立した計算とテストを分離できる利点もある。
- game/run-summary.ts は小さいが、game と launcher/save の間を渡る DTO であり、境界を示すファイルとして独立している。

したがって、「依存が一つで、その依存としか使わない短い定義」は統合を検討するための検索条件にはなるが、自動的な修正規則にはしない。

### 4.3 依存削減と import 増加

現在の graph では game/game.ts が 53 個、player.ts が 67 個の内部モジュールへ依存している。これは Game がオーケストレータ兼組み立て役であることの証拠であり、変更影響を推論しにくいという懸念を支持する。

一方、型・定数・小さな計算を別ファイルへ切り出した場合、import の本数が増えるのは自然である。評価すべきなのは次の組み合わせである。

1. 変更理由が同じものが同じモジュールに集まっているか。
2. 上位の変更が下位の内部実装まで知る必要があるか。
3. import が type-only か、実行時のオブジェクト生成・副作用を伴うか。
4. 依存方向に循環がないか。
5. 末端の計算を単独テストできるか。

「import 行を減らす」だけを目標にすると、巨大な万能 interface や barrel を作って、見かけの import だけを隠す結果になりうる。

### 4.4 physics、simulation、DOM の境界

src/physics と src/math には、実際の DOM/Three import はない。game/dynamic/simulator.ts も physics、Stage、DynamicEntity、CelestialMotion を使うだけで、DOM を直接扱っていない。この境界は維持する価値が高い。

しかし、game 層の DynamicSystem は別である。game/dynamic/dynamic-system.ts:61–75 の constructor は THREE.Scene、Hud、音、エフェクト、マーカー、CelestialSystem を受け取り、restore や NanWatchdog にそれらを渡している。また :308–320 の sync はカメラ、表示設定、グラフィックス設定、軌道表示などを受け取って全エンティティの表示を同期する。

よって「物理コアは DOM から疎」「ゲームの動的オブジェクト管理まで含めれば密結合」という二段階の認識が正確である。後者を一気に React へ移すより、Simulator と physics の境界を保ったまま、DynamicSystem の表示・復元・監視の依存を段階的に分けるべきである。

### 4.5 HUD が Game 全体を知っている問題

この懸念は現在のコードに明確な根拠がある。

- game/hud/hud.ts:87–106 の updateAnalysisReaders と syncPanels は Game を受け取る。
- 同じ syncPanels から topBar、orbitPanel、mapScaleBadge、vesselPanel、targetPanel、enemiesPanel、orbitAnalysisWindow へ Game を渡す。
- game/hud 以下で Game 型を import するファイルは 12 個ある。
- top-bar、vessel-panel、target-panel、enemies-panel、map-scale-badge、orbit 関連の各 panel が Game の別々の subsystem へ到達している。
- game/hud/hud.ts:110–132 は view 切替時に DOM 要素を手動で別 root へ移動する。

ただし、すべてが未整理なわけではない。BurnManagementPanel は managementViewModel を受け取り、TargetPanel には表示用データ型へ分ける方向が既にある。これは、全体を React 化する前に read model を増やす方針が現コードに適合することを示す。

修正の中心は Hud に Game を渡さないことにする。パネルごとに必要な不変スナップショットを Game 側または presenter が組み立て、操作は速度変更などの狭い command callback/port で返す。Orbit analysis のように計算が重いものは、Game そのものではなく、必要な問い合わせだけを持つ OrbitAnalysisSource のような境界を定義する。

### 4.6 celestial の不変性と表示責務

会話の「時刻を問い合わせると状態が得られる純粋関数」という理解は、CelestialMotion の中心部分にはかなり当たっている。physics/kinematic-state.ts:30–44 は KinematicState を不変として扱い、新しい状態を作って進める。CelestialMotion も時刻から状態を求め、physics/time-ring.ts のキャッシュを使う。

ただし、CelestialSystem は表示専用の静的情報ではない。

- game/celestial/celestial-system.ts:96–169 は CelestialMotion と同時に Scene、星、照明、影、グリッド、露出などの資源を保持する。
- :171–195 の build は Three のシーンへ天体表示を登録する。
- :379–449 の sync は天体の可視性、メッシュ、照明、影、グリッドを毎フレーム更新する。
- pointFieldBuilt、orbitGuideSettings、gridVisibility などの mutable な状態を持つ。
- CelestialEntity も motion に加えて build、setVisible、sync、dispose を持つ。

従って、将来の分割対象は「celestial を React component へ移す」ではなく、「時刻問い合わせ・天体定義」と「Three の表示資源」を分けることである。CelestialMotion/kinematic-state を問い合わせ側の正本として残し、必要になった箇所から CelestialView または render adapter を分離する。キャッシュや座標変換を表示コンポーネントへ複製してはいけない。

## 5. 修正案

### P0: Game 全体を HUD へ渡す境界を狭める

1. Hud.syncPanels を、Game ではなくフレーム単位の HudFrame と各パネルの Model を受け取る形へ寄せる。
2. TopBar、VesselPanel、TargetPanel、EnemiesPanel、MapScaleBadge、OrbitPanel について、それぞれ必要な readonly data を列挙する。
3. パネルからシミュレーションを変更する処理は、Game の参照ではなく狭い command callback または command port にする。
4. 軌道分析は、必要な天体・対象・予測問い合わせだけを持つ専用 source と表示用結果に分ける。
5. Game は update/sync の順序と値の組み立てを担当する。DOM panel は Game の subsystem を探索しない。

これは値の依存をなくす変更ではない。値を一か所で集約し、ソース上の変更影響を panel 単位に閉じ込める変更である。

### P1: simulation と表示同期を段階的に分ける

1. physics、math、Simulator の境界は維持する。Simulator に DOM/HUD を渡さない。
2. DynamicSystem から表示資源を直に必要とする箇所を分類する。シミュレーション用の entities/simTime、復元、NaN 監視、表示同期を一度に分割しない。
3. DynamicEntity の sync 引数を、描画に必要な frame data と simulation query に分ける。
4. 変更後も DynamicSystem がシミュレーションの顔ぶれと simTime の正本であることを維持する。

### P1: celestial の問い合わせと表示資源を分ける

まず CelestialMotion、KinematicState、時刻系の問い合わせ API を安定させる。その後、具体的な render dependency が見つかった単位から CelestialSystem の表示部分を adapter/view へ移す。CelestialSystem 全体を React component にする案は採用しない。

### P1: 型ファイルの統合判断を明文化する

統合候補は次の条件をすべて確認してから変更する。

- consumer が一つか、共有語彙ではないか。
- 型・計算・DOM の責務が同じ変更理由を持つか。
- 独立したテスト境界を失わないか。
- import 循環や巨大ファイル化を起こさないか。
- ファイルを統合した結果、呼び出し側の責務が減るか。

generic は「重複を減らせるか」ではなく、「型引数によって置換可能性、値の型保持、または混同防止が得られるか」で採否を決める。

### P2: React は DOM 限定で小さく試す

React を試すなら、まず settings/help など Three の scene graph と直接関係しない浅い DOM surface を対象にする。先に P0 の read model/command 境界を作り、React component に Game を渡さないことを終了条件にする。

Combat HUD や Three の表示を最初の移行対象にしない。React を導入しても、component が Game や DynamicSystem を直接読む設計なら、現在の密結合を別の書き方へ移しただけになる。

## 6. 今回は採用しない案

- 全パネルへ渡す GameContext、万能 Services、DI コンテナ、イベントバスを最初の解決策にする。
- 型の形が似ているだけのものを generic にまとめる。
- celestial を表示 component または React component へ丸ごと移す。
- DOM の問題を理由に Three.js/Renderer 全体を置き換える。
- DynamicSystem の責務問題を、いきなり ECS 導入で解決する。

これらは依存を見えなくしたり、境界を増やしたりするだけで、変更影響の推論可能性を保証しない。

## 7. 将来の変更で確認すること

- HUD panel が Game 型を直接 import せず、panel-specific model と command だけを受け取る。
- src/physics と src/math に DOM/Three の実 import が入っていない。
- Simulator が HUD/DOM を知らず、DynamicSystem が simTime と entity registry の正本であり続ける。
- CelestialMotion の問い合わせ・キャッシュを表示側が複製しない。
- 依存 graph の edge 数だけでなく、runtime import、type-only import、循環、変更理由を別々に見る。
- コード変更後は npm run typecheck を必須とし、game/physics/render のどの層を触ったかに応じて対応する回帰テストを走らせる。

今回の作業は調査とこのメモの追加だけであり、コード変更とテスト実行は行っていない。
