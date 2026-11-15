# 天体接触・当たり判定の軽量化計画

## 対象スナップショット

- 対象ブランチ: `workspace3`
- 対象コミット: `1ebe43d4f`
- 対象: `src/physics/` の天体表面・compound 接触、および `src/game/dynamic/` / `src/game/ship/` の接触形状配線
- 現在の作業ツリーにある `memos/mikanixonable/game-presentation-refactoring-plan_2026-09-20.md` と `solar-radiator-realism-plan_2026-09-20.md` は別作業であり、この計画の対象に含めない

## 目的

時間加速が `x4096` を越えたときに急増する天体表面接触の負荷を、接触の見逃し・接触時刻の逆転・描かれた船体の未判定を起こさずに下げる。薬莢・宇宙船・その他の物体どうしの接触も、同じ形状データを再利用できる構造へ整える。

現状は `DynamicSimulator` の各サブステップで生存物体を天体候補へ渡し、compound shape の場合に `sweptCompoundCylinderSphereContact` が姿勢・並進の移動量を形状の最小特徴量で刻む。60 fps の概算では、`x4096` は約 68 sim 秒/フレームで最大 4 サブステップ、`x65536` は約 1092 sim 秒/フレームで最大 55 サブステップになる。20 秒のサブステップ中に 7.8 km/s で 156 km 進み、最小特徴量 3 m のとき、現行式は `156000 / (3 × 0.25) ≈ 208000` 回の narrow phase 候補を要求しうる。開始・終了のどちらも天体から遠い軌道では、この大半が空振りである。

## 決めたこと

- 物理の正確さを優先し、球体代理を直ちに最終接触形状へ置き換えない。球体代理はまず、正確な capped-cylinder 判定へ進む必要があるかを決める保守的な広域判定として使う。
- 円柱形状を複数の球で表す案は、円柱を内包する球の集合として導入する。球代理が早く接触しても、それだけで接触確定にはせず、現行の exact compound 判定で形状の実接触を再確認する。
- `compoundShape` は物体どうしの接触・選択など既存の正確な形状へ残し、天体表面の広域判定用に `surfaceShape` を別に持たせる。両者を同じ欄へ合成しない。
- キャッシュは、入力形状が不変であることを所有側が保証する前提で、形状オブジェクトをキーにする。キャッシュの整合性管理を呼び出し側へ漏らさない。
- この最初の実装ではサブステップ上限・時間加速の仕様を変更しない。高倍率で物体どうしの接触を無効化する既存の `MAX_PHYS_SIM_SPEED = 4` も変更しない。
- 仕様上の「経路全体」「最初に触れた相手」「描かれた構造全体」の挙動は保存する。今回の目的は近似による挙動変更ではなく、不要な exact 判定を減らすことである。

## 指摘項目1〜6

### 1. 天体の外接球による解析的な事前除外

compound shape の全体を含む bounding sphere と天体の表面球との掃引を、capped-cylinder の exact sweep より先に解く。経路上で外接球すら天体へ届かない場合は、その天体の exact 判定を呼ばない。終端で既にめり込んでいる場合は、現在の compound の終端判定へ進む。

開始・終了位置だけの距離比較では高速通過を落とすため、物体と天体の双方の経路を受ける既存の球掃引を入口にする。球の判定で接触候補になった場合は exact 判定へ戻し、外接球の膨らみによる偽陽性を最終結果へ流さない。

### 2. 全区間の adaptive cylinder sweep を球代理の直接 TOI へ置き換える

surface 用の球代理を primitive 単位で走査し、球同士の解析的な二次 TOI、または既存の球掃引の曲線判定で、候補区間と最初の候補時刻を求める。遠方の区間を `minFeature` 刻みで円柱へ問い合わせる経路を表面判定の第一手から外す。

初回実装では sphere union を最終判定にせず、球代理が候補を返したときだけ exact cylinder narrow phase を呼ぶ。この段階で「空振り区間の数十万回の cylinder 判定」を避け、将来、代理と exact の差を計測してから候補区間内の exact 探索へ狭められるようにする。

### 3. `surfaceShape` / `compoundShape` / `boundingRadius` の分離

`compoundShape` は moduleId と capped-cylinder の正確な剛体形状、`surfaceShape` は天体表面の候補絞り込みに使う sphere proxy、`radius` は既存の広域 bounding radius として明確に分離する。船の形状導出時に、同じ module の primitive から両方を同じ世代で生成する。

薬莢や一般の球物体の既存経路は `surfaceShape = null` のまま使えるようにし、既存の `radius` による球接触を壊さない。代理を持つ船だけが sphere union の表面 prepass を利用する。

### 4. 準備済み compound shape のキャッシュ

`sortedPrimitives()` の配列複製・ソート・有限値検証・軸長検証と、sweep 分割数に使う shape metrics を、同じ不変 shape に対して一度だけ行う。pose に依存する world transform は毎問い合わせ必要なので、キャッシュへ混ぜず、局所 shape の準備データだけを保持する。

キャッシュのキーは shape object identity とし、shape の交換時には `DynamicMotion` が新しい不変 shape object を受け取る。キャッシュが古い shape を返すこと、無効 shape を有効として扱うこと、テスト用の不正入力の検証を省略することがないようにする。

### 5. primitive ごとの特徴量で sweep を分ける

現行の `minFeature` 1個で全 primitive の刻みを決めるため、細い突起が長い主船体の sweep 全体を高密度にする。primitive ごと、または安全にまとめられるグループごとに、移動量・角度・形状特徴量を使って探索区間を分ける。

項目1〜4の候補除外とキャッシュ後に、実測でまだ負荷の中心が残る場合の次段とする。正確な最初の TOI を保つため、探索区間の比較と moduleId の tie-break を同時に見直す。

### 6. 高倍率時の衝突 LOD と substep 上限の再評価

`x4096` 以上で物体どうしの交戦判定が抑制される既存の時間加速制限と、天体表面接触を全生存物体へ適用する仕様を分けて測る。surface prepass・shape cache・primitive 単位 sweep の後も、物体数と天体数の積が支配的なら、接触候補の更新頻度、非交戦物体の形状解像度、substep 上限を再評価する。

これは天体表面の到達時刻・姿勢・温度・反発を飛ばす可能性があるため、項目1〜4の結果を見ずに変更しない。仕様変更または近似の採用が必要になった場合は、別計画として切り出す。

## 最初の1手: 項目1〜4の実装

### 目的

空振りの天体接触を球の prepass で除外し、船体だけに持たせる表面代理と不変形状キャッシュを導入する。exact capped-cylinder 判定は候補後に残し、現在の衝突結果を保つ。

### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/physics/compound-sphere-contact.ts`（新規） | surface proxy の型と、primitive ごとの球掃引による最初の候補時刻を持つ純粋な物理幾何を実装する。直接二次解を速い経路とし、曲線経路を見逃さないため既存の球掃引へ戻せる形にする。 |
| `src/physics/surface-contact.ts` | shape の `surfaceShape` / `boundingRadius` を使った保守的 prepassを exact compound の前に置く。候補が無い天体では cylinder sweep と終端判定を呼ばない。候補後の `moduleId`、最初の TOI、終端 push-out は exact 結果から作る。 |
| `src/physics/compound-cylinder-contact.ts` | sorted primitive と shape metrics の WeakMap cache を追加する。入力検証、決定的な sort、無効入力の null 返却は保つ。 |
| `src/game/ship/ship-physics-shape.ts` | 同じ COM 基準の cylinder primitive から、moduleId 付きの surface sphere proxy を同じ世代で導出する。proxy は cylinder を内包する回転不変の広域候補形状とする。 |
| `src/game/dynamic/dynamic-motion.ts` | collision properties に optional な surface shape の交換・読み取りを加え、既存の呼び出し側が省略した場合は null とする。shape 世代の交換時に exact shape と proxy shape を一括更新する。 |
| `src/game/dynamic/dynamic-simulation-participant.ts` | surface participant が surface shape を読むための狭い物理面を追加する。 |
| `src/game/dynamic/contact-proxy.ts` | 付属物 proxy は surface shape を持たないことを明示する。 |
| `src/game/ship/modular-ship-motion.ts` | 初期構築・assembly 同期の両方で `surfaceShape` を exact shape と同じ世代へ渡す。 |
| `tests/physics/surface-contact.test.ts` | 外接球だけが当たる経路では exact 判定へ進まず接触なしとなること、surface proxy が候補を返しても exact cylinder が空間の偽陽性を拒否すること、移動天体・回転途中・開始時のめり込みを保つことを検証する。 |
| `tests/physics/compound-cylinder-contact.test.ts` | 同一 shape を繰り返し問い合わせても結果・不正入力の扱いが変わらないことを検証する。 |
| `tests/game/dynamic-motion-shape.test.ts` | surface shape の交換、null 既定値、exact shape と世代が一致することを検証する。 |

### 達成条件と検証

- `surfaceShape` の無い既存参加者は従来の sphere path を通り、型検査で全 participant 実装が surface shape を満たす。
- compound surface contact は、遠方の候補に対して `compoundCylinderSphereContact` / `sweptCompoundCylinderSphereContact` を呼ばず、候補がある場合だけ exact 結果を使う。
- surface proxy だけが重なる配置で天体接触を返さず、実際の capped-cylinder が触れる配置では従来と同じ body・moduleId・最初の TOI を返す。
- 不正な shape は従来どおり contact なしまたは `replaceCollisionProperties` の例外となり、cache が検証を迂回しない。
- `rg -n "surfaceShape|compoundSphere" src tests` で、surface proxy の所有者が physics shape / dynamic motion / surface contact に限定され、entity contact の正確な `compoundShape` と混ざっていない。
- `npm run typecheck`
- `npm run test:physics`
- `npm run test:game`
- `npm run check:boundaries`
- `git diff --check`

## 実装後のコードレビューとバグ調査

1. 変更差分へ `DEVELOP/CODING-RULE.md` と `DEVELOP/ARCHITECTURE.md` を当て、physics にゲーム調整値・描画依存・近似を持ち込んでいないか確認する。
2. `firstSurfaceContact` の body 列挙順、同時刻の tie-break、開始時に既に内部にいる場合、天体自身の移動、回転中の船体、moduleId の引き継ぎを確認する。
3. sphere proxy の false negative がないか、遠方通過・接線通過・代理だけの接触・実形状接触を回帰テストで確認する。false positive は exact fallback で最終的に排除されることを確認する。
4. WeakMap cache が object identity 以外の入力を取りこぼしていないか、shape の再利用・交換・無効 shape を確認する。
5. テスト失敗や型エラーが今回の変更由来なら修正し、同じ検証を再実行する。変更と無関係の既存失敗は原因とともに記録する。
6. レビューと検証後にこの計画へ実測結果、発見したバグ、修正内容、未実装の項目5〜6を追記する。

## worktree と統合の手順

1. この計画だけを `workspace3` へ単独 commit する。既存の未追跡メモは stage しない。
2. `workspace3` の計画 commit を起点に専用 worktree と一時ブランチを作り、項目1〜4の実装・テスト・レビューをすべてそこで行う。
3. 専用 worktree の変更を実装、レビュー、バグ修正、文書更新の単位で commit する。
4. 起点 `workspace3` の HEAD と未コミット変更を再確認し、専用ブランチを `workspace3` へ統合する。別作業の未追跡メモを commit に含めない。
5. 統合 commit を確認した後、今回作成した worktree と一時ブランチだけを削除する。

## 見積り

- 計画・起点固定・worktree 作成: 計画文書の作成 1 件 + 起点確認 1 回 + worktree 作成 1 回。
- 項目1〜4実装: 新規 sphere geometry 1 モジュール + 既存配線 7〜9 ファイル + 回帰テスト 3 ファイル。実装量は現行の compound surface 接触経路を読み替える箇所数に比例し、固定時間では見積もらない。
- レビュー・バグ調査: 遠方通過、接線、開始時重なり、動く天体、回転、shape 交換の6ケースを最低限確認する。
- 検証: `typecheck` 1 回、physics/game の回帰テスト各1回、boundary check 1 回、差分空白検査 1 回。失敗時は修正ごとに該当検証を再実行する。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| bounding sphere の no-hit 判定が実際の回転経路を含まない | 長い船体が回転途中で天体をすり抜ける | 最初の1手、surface-contact の回転途中テスト、コードレビュー |
| sphere proxy の早い接触を最終接触として返す | 空間しかない場所で機体が失われる | 最初の1手、代理だけの偽陽性テスト、exact fallback のレビュー |
| sphere union が moduleId を失う | 接触ダメージ対象・通知先が別 module になる | 最初の1手、surface-contact の moduleId テスト |
| body の移動を静止扱いする | 動く天体との相対接触を取りこぼす | 最初の1手、moving body テスト |
| cache key や cache 内容が shape 世代を一部しか含まない | assembly 更新後に古い形状・古い特徴量で判定する | 最初の1手、dynamic-motion shape 世代テスト、レビュー |
| 空の shape / 非有限値の検証を cache hit で迂回する | 不正入力が無言で接触形状になる | 最初の1手、compound shape 不正入力テスト |
| prepass によって endpoint overlap の既存 fallback が消える | 既に内部にいる物体が押し戻されない | surface-contact の開始時・終端重なりテスト |
| `surfaceShape` を entity contact へ誤配線する | 物体どうしの正確な円柱接触が球近似へ変わる | 変更差分レビュー、entity contact 回帰 |
| 別作業の未追跡メモを staging する | ユーザーの作業を今回の統合へ混ぜる | 起点固定、各 commit 前の `git status --short` |
| 項目5・6を同時に入れる | substep/判定仕様まで変わり、原因切り分け不能になる | 実装範囲レビュー、最終報告 |

## 実施後の記録

### 実装・レビュー結果

- 専用 worktree は `/Users/pandeaconica/lab/dive-into-tepui-surface-opt`、ブランチは `codex/surface-contact-optimization-20260920`。起点は計画 commit `3680655cf`。
- 項目1: `compound-sphere-contact.ts` に、各円柱 primitive を COM まわりの回転不変 envelope 球へ広げる保守的 prepass を追加した。線形経路は二次解を先に使い、曲線経路を落とさない場合は既存 Hermite 掃引へ戻す。
- 項目2: sphere proxy は候補検出だけに使い、候補がある場合も exact capped-cylinder sweep / endpoint overlap を実行する。proxy の TOI や moduleId は最終結果へ使わない。
- 項目3: `DynamicMotion` が exact shape と surface proxy を同じ世代で交換・凍結し、proxy の外包が exact shape の全 primitive を含むことを検証する。ship の COM 基準 primitive から proxy を導出し、付属物 proxy は null のままとした。
- 項目4: `compound-cylinder-contact.ts` の sorted primitive と shape metrics を shape identity の `WeakMap` へキャッシュした。入力検証・決定的 sort・不正 shape の null 扱いは維持した。
- 物理結果を球近似へ置き換える判断は採用しなかった。円柱を複数球へ置換すると false positive だけでなく、単純な球集合では姿勢・円柱表面の接触点と moduleId を失うため、今回の段階では安全な候補絞り込みに限定した。

### コードレビュー・バグ調査

- レビュー指摘: surface proxy が exact shape を内包しないと prepass が false negative になる。`DynamicMotion` の交換時に `proxyBound >= exactBound` を検証して、更新を原子的に失敗させるよう修正した。
- この検証を追加した直後、game test の proxy 半径 `2` が exact cylinder の外包半径を下回っていることを検出した。これは実装バグではなくテスト治具の契約違反だったため、半径を `3` へ修正し、過小 proxy を拒否するテストを追加した。
- 回帰確認では、開始時のめり込み、区間終端 overlap、動く天体、回転途中の接触、最初の TOI、moduleId、proxy だけの false positive、姿勢なしの既存呼び出しを確認した。いずれも異常なし。
- ESLint はエラー 0 件。`dynamic-motion.ts` の既存ファイル長警告（781行、上限500行）が残るが、今回の機能とは別の既存構造であり、この段階では分割しなかった。

### 実装 commit と検証

- 実装 commit: `7b10943ee perf(physics): add conservative surface contact prepass`
- `npm run typecheck`: 成功
- `npm run test:physics`: `507/507 passed`
- `npm run test:game`: `297/297 passed`
- `npm run check:boundaries`: 違反 0 件

- `git diff --check`: 成功
- 実行時ブラウザ計測は今回の依頼範囲では行っていない。したがって、x4096 / x65536 の wall-clock 改善率は未計測であり、次段では exact narrow phase 呼び出し回数と `update` の planet contact 時間を同じシナリオで比較する。

### 統合・残課題

- この文書の更新 commit は、実装 commit 後の専用ブランチへ追加する。続いて `workspace3` へ統合し、統合を確認してから今回作成した worktree と一時ブランチだけを削除する。
- 項目5（primitive 特徴量ごとの sweep 分割）と項目6（高倍率時の衝突 LOD / substep 上限再評価）は未実装。項目1〜4後の実測で exact sweep がまだ支配的かを確認してから着手する。


## 残タスク追補

### 実装結果

- 起点は `workspace3` の `df9957426`、専用 worktree は `/Users/pandeaconica/lab/dive-into-tepui-surface-remaining`、ブランチは `codex/surface-contact-remaining-20260920`。
- 項目5を実装した。`sweptCompoundCylinderSphereContact` は compound 全体の最小特徴量で一律に刻まず、各 primitive の移動量・回転角・外接半径・最小特徴量から個別の subdivision 数を決め、各 primitive の exact contact を最初の TOI と moduleId の決定規則で比較する。compound-compound sweep は変更していない。
- 項目6は、同一 substep 内で複数物体が同じ天体の同じ時刻を読む状態を `SurfaceContactPhysics` 内で共有する安全なキャッシュを実装した。接触判定のLOD化、接触回数の削減、`SUBSTEP_MAX_COUNT` の縮小は行っていない。
- 実装 commit: `0be8c1fcc perf(physics): split compound sweeps by primitive`

### 実測とレビュー

- 同一 Node プロセスの専用物理ベンチ（太い primitive + 細い primitive、空振り sweep 20回）では、項目5前 `824.2 ms`、項目5後 `533.1 ms`。約35.3%減、約1.55倍の改善だった。これは narrow phase の単体比較であり、x4096 / x65536 のブラウザ全体 wall-clock 改善率ではない。
- レビューでは、primitive単位に分割しても各primitiveの運動量と特徴量から必要な刻みを計算するため、細い別primitiveの密度を太いprimitiveへ伝播しない一方、各primitiveの経路を落とさないことを確認した。
- 同時TOIは moduleId の辞書順で決め、入力配列順に依存しない。球近似を最終接触へ使わず、最終結果は引き続き capped-cylinder から返す。
- ORBIT の「生存物体はすべて天体接触へ参加」「経路全体」「最初の接触」「時間加速で計算が終わらない」を守るため、高倍率で接触を飛ばすLODやsubstep上限の縮小は採用しなかった。項目6の残る候補は、実ランの `SECTION.celestialContact` 計測を伴う別の仕様検討とする。

### 検証

- `npm run typecheck`: 成功
- `npm run test:physics`: `509/509 passed`
- `npm run test:game`: `306/306 passed`
- 変更箇所の ESLint: エラー 0 件
- `git diff --check`: 成功
- `npm run check:boundaries`: 違反 0 件

## 高倍率向け衝突LOD導入計画

### 対象スナップショット

- 対象ブランチ: `workspace3`
- 対象コミット: `2b24ed8af`
- 対象: 天体表面接触の形状解像度。物体どうしの接触、予測軌道の積分、substep 上限は対象外とする。

### 目的

`x4096` を超える時間加速で、天体接触の exact compound sweep が生存物体数とサブステップ数に比例して膨らむ。天体への到達結果を保つ必要がある物体は exact のままにし、接触時刻や module 単位の精度がゲーム結果へ影響しない一時物体だけを、明示的な保守的球代理へ切り替えて `SECTION.celestialContact` の負荷を下げる。

### 決めたこと

- これは単なる内部最適化ではなく、既存の「時間加速倍率は判定の答えを変えない」という仕様に例外を加える変更である。実装前に `DEVELOP/SPEC/ORBIT.md` と `DEVELOP/SPEC/GAME.md` を単独の仕様コミットで更新する。
- LOD は天体表面接触だけに適用する。物体どうしの接触は `MAX_PHYS_SIM_SPEED = 4` の既存ゲートを保ち、今回の計画で高倍率接触を再開したり、別形状へ置き換えたりしない。
- 形状解像度は既定を `exact` とし、動的物体が構築時に `highWarpCoarse` を明示した場合だけ、`simSpeed > 4096` で `surfaceShape` を最終接触形状として使う。physics がグローバルな速度管理を読むのではなく、進行側がそのフレームのモードを引数で渡す。
- `highWarpCoarse` は exact shape を内包する球集合だけを受け付ける。接触を見逃してはならないが、球代理が外側へ膨らむぶんだけ早く接触することは、明示的に許可された一時物体についてのみ認める。proxy の膨らみが物体の許容誤差を超える形状は opt-in を拒否する。
- controlled ship、予測軌道を持つ物体、天体接触で module 単位の反応・ダメージ・出来事を生成する物体は `exact` を保つ。`highWarpCoarse` の参加者は予測弧を持たず、surface contact callback によるゲーム上の分岐を持たない一時物体に限定する。
- サブステップ数を減らさない。大気抵抗、加熱、姿勢、経路全体の積分は従来どおり進め、LOD は候補後の exact capped-cylinder narrow phase を球代理へ置き換える部分だけに限定する。
- 薬莢の物体間接触を今回の LOD で解決しようとしない。薬莢が surface shape を持たず既存の球経路を通る場合、surface LOD の追加効果はないため、残る負荷が物体間接触なら別計画へ切り出す。

### 変えない挙動

- `exact` 参加者について、経路全体、相手天体の移動、区間内の最初の接触、開始時・終端の重なり、回転途中の接触、moduleId、接触反応、反発と加熱を変えない。
- どの LOD でも生存物体を天体接触の参加者から除外せず、天体候補の上限や処理打ち切りを導入しない。
- exact shape と surface proxy の世代を分離せず、assembly 変更後に古い proxy を使わない。
- `compoundShape` を物体どうしの接触、選択、module 単位の反応へ流用し、surface LOD を entity contact へ漏らさない。

### LODによって変わる挙動

- `highWarpCoarse` の一時物体は、exact shape なら接触しない proxy の外側で、最大で宣言した proxy 膨らみぶん早く天体接触として失われる可能性がある。球代理の内側にある exact 接触を落とすことは許可しない。
- 同じ一時物体でも `simSpeed <= 4096` では exact を使う。したがって高倍率への切り替えは、その物体の接触時刻へ影響しうるが、対象は仕様で定める低重要度物体に限る。

### 達成目標

- x4096・x65536 の同一シナリオで、`SECTION.celestialContact` の中央値を、LOD導入前ベースライン比で 30% 以上削減する。削減率は `(baseline - lod) / baseline` で計算し、Node 単体の narrow phase ベンチと実シミュレーション計測を分けて記録する。
- `highWarpCoarse` 参加者で exact narrow phase 呼び出しが 0 件になり、coarse proxy の接触数・接触天体・接触時刻が決定的になる。
- 物体数、姿勢、天体移動、時間加速段を変えた回帰テストで、`exact` の結果が現行と一致する。
- proxy の false negative が 0 件で、proxy の早期接触距離が各物体の宣言した許容誤差以内に収まる。
- `npm run typecheck`、`npm run test:physics`、`npm run test:game`、`npm run check:boundaries`、`git diff --check` が成功する。

### 手順

#### 手順1. LODの仕様契約を先に確定する

**目的**

高倍率で接触時刻が変わりうる範囲を仕様として明文化し、実装が速度倍率を理由に任意の物体を近似しないようにする。

**変更が必要な箇所**

| ファイル | 変更内容 |
| --- | --- |
| `DEVELOP/SPEC/ORBIT.md` | exact 接触を要求する物体、保守的 proxy を許す一時物体、proxy の false negative 禁止、許容誤差、予測弧との関係、substep を削らないことを仕様として追加する。 |
| `DEVELOP/SPEC/GAME.md` | 高倍率時の表面接触 LOD が時間加速倍率に対する明示的なゲーム上の例外であることを追加する。物体間接触の既存上限は変更しない。 |

**達成条件と検証**

- 仕様だけの `docs(spec): define high-warp surface contact lod` commit を作れる状態になる。
- `ORBIT.md` の「時間加速倍率が判定の答えを変えない」と矛盾しないよう、低重要度の表面接触だけが例外として読める。
- exact 参加者と coarse 参加者の分類、proxy の許容誤差、予測弧を coarse にしない条件が数値または観測可能な条件で書かれている。
- 実装は行わず、仕様コミット後にのみ手順2へ進む。

#### 手順2. ベースラインとLOD計測値を追加する

**目的**

LOD の採用でどの費用が減ったかを、候補数だけでなく exact narrow phase、coarse contact、サブステップ、`SECTION.celestialContact` の時間で比較できるようにする。

**変更が必要な箇所**

| ファイル | 変更内容 |
| --- | --- |
| `src/game/dynamic/surface-contact-physics.ts` | frame ごとに surface participant 数、候補数、exact 判定数、coarse 判定数、coarse hit 数を数える。接触の答えは変更しない。 |
| `src/game/dynamic/simulator.ts` | surface contact の計数を `perfCounts()` へ差し出す。substep 数と integrated/followed 数は既存値を保つ。 |
| `src/game/perf-counts.ts` | LOD計測値の読み取り専用フィールドを追加する。 |
| `src/game/hud/windows/debug-info-window.ts` | デバッグ窓へ exact/coarse の計数を追加し、500ms 集計の既存方式で平均・最大を表示する。 |
| `tools/bench/surface-contact-lod.mjs`（新規） | 固定した物体数・天体数・姿勢・時間区間で x4096 / x65536 を繰り返し、section時間と計数を比較する。 |
| `package.json` | ベンチを再実行できる `bench:surface-contact-lod` script を追加する。 |
| `tests/game/surface-contact-lod.test.ts`（新規） | 計数のリセット、exact/coarse の分類、同一フレーム内の集計を検証する。 |

**達成条件と検証**

- LOD未導入のベースラインを x4096 / x65536 各100フレーム以上で保存し、`SECTION.celestialContact`、候補数、exact 判定数を記録する。
- 計数を有効にしても接触結果、サブステップ数、物体数、予測弧が変わらない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`、`npm run bench:surface-contact-lod`。

#### 手順3. LODポリシーを進行から物理へ明示的に渡す

**目的**

時間加速の段、物体ごとの opt-in、予測弧の有無を一箇所で判定し、physics がゲーム状態やグローバル速度管理を直接参照しない構造を作る。この時点では全参加者を exact とし、挙動を変えない。

**変更が必要な箇所**

| ファイル | 変更内容 |
| --- | --- |
| `src/physics/surface-contact-lod.ts`（新規） | `exact` / `coarse` のモードと、proxy の許容誤差・モード選択に必要な不変型を定義する。ゲームの entity 種別は持ち込まない。 |
| `src/game/dynamic/dynamic-motion.ts` | 物体ごとの `surfaceContactFidelity` と proxy 計測値を読み取り専用で持ち、既定を `exact` にする。coarse と予測弧・surface callback の不整合を構築時に拒否する。 |
| `src/game/dynamic/dynamic-simulation-participant.ts` | surface contact が読む fidelity の狭い面を追加する。entity contact には渡さない。 |
| `src/game/dynamic/sim-speed-manager.ts` | 現在の速度段から surface contact mode を純粋に返す。初期閾値は `simSpeed > 4096` とし、仕様とベンチ結果を根拠に変更できる一箇所へ置く。 |
| `src/game/game.ts` | フレーム先頭で確定した速度段から surface contact mode を組み、進行へ一度だけ渡す。 |
| `src/game/dynamic/dynamic-system.ts` | `simDt` と同じフレームの mode を `Simulator` へ受け渡す。 |
| `src/game/dynamic/simulator.ts` | `SurfaceContactPhysics` へ mode を渡す。substep の数・積分・entity contact は変更しない。 |
| `tests/game/sim-speed-manager.test.ts`、`tests/game/dynamic-motion-shape.test.ts` | 閾値、既定 exact、予測弧との不整合拒否、保存データに派生 mode を追加しないことを検証する。 |

**達成条件と検証**

- mode を渡しても全 participant が exact で、既存の surface contact テスト結果が変わらない。
- `simSpeed` を physics 層から直接 import する箇所が 0 件になる。確認語: `rg -n "sim-speed-manager|SIM_SPEED_LEVELS" src/physics`。
- `highWarpCoarse` を指定した予測弧持ち、surface callback 持ち、許容誤差を超える proxy は構築時に拒否される。
- `npm run typecheck`、`npm run test:physics`、`npm run test:game`、`npm run check:boundaries`、`git diff --check`。

#### 手順4. coarse surface contact を実装する

**目的**

high-warp mode かつ明示的な coarse participant に限り、既存 `surfaceShape` の球集合を最終接触として使い、exact capped-cylinder sweep を省く。exact participant の経路は変更しない。

**変更が必要な箇所**

| ファイル | 変更内容 |
| --- | --- |
| `src/physics/compound-sphere-contact.ts` | sphere union の swept hit が deterministic な最初の TOI と moduleId を返すこと、endpoint overlap と移動天体を扱えることを確認・補強する。 |
| `src/physics/surface-contact.ts` | `exact` は現行の proxy prepass + capped-cylinder fallback、`coarse` は validated `surfaceShape` の hit を最終 geometry とする分岐を追加する。既定引数は `exact`。 |
| `src/game/dynamic/surface-contact-physics.ts` | participant fidelity と frame mode の両方から実際の判定モードを決め、coarse の exact narrow phase 呼び出しを 0 件にする。coarse hit も既存の反発・熱・reaction 配線へ渡す。 |
| `tests/physics/compound-sphere-contact.test.ts` | sphere union の最初の TOI、同時刻 moduleId tie-break、移動天体、開始時内部、非有限入力を検証する。 |
| `tests/physics/surface-contact.test.ts` | exact と coarse の結果、coarse の早期接触、proxy-only hit、endpoint overlap、候補無し経路を検証する。 |
| `tests/game/surface-contact-physics.test.ts` | high-warp coarse のみ exact geometry を呼ばないこと、exact participant は従来経路を通ること、計数が一致することを検証する。 |

**達成条件と検証**

- coarse proxy が exact shape を内包する入力で false negative が 0 件になる。
- coarse participant の contact body、TOI、moduleId は入力順に依存せず、同一入力で常に同じになる。
- exact participant の body、TOI、moduleId、push-out、反発、熱、reaction が導入前と一致する。
- `npm run typecheck`、`npm run test:physics`、`npm run test:game`、`npm run check:boundaries`、`git diff --check`。

#### 手順5. 一時物体へ段階的にopt-inし、実測で採否を決める

**目的**

ゲーム上の意味が小さい物体だけを coarse LOD へ切り替え、実シナリオで負荷削減と早期接触の許容範囲を確認する。まず薬莢・慣性を持たない一時破片を対象にし、宇宙船の近似は別の判定を通す。

**変更が必要な箇所**

| ファイル | 変更内容 |
| --- | --- |
| `src/game/dynamic/dynamic-entity/debris-motion.ts` | surface callback と予測弧を持たない、明示した一時破片だけへ `highWarpCoarse` を設定できる構築値を渡す。 |
| `src/game/dynamic/dynamic-entity/debris-piece.ts` | 破片の種類から描画上の種別ではなく、物理上の surface fidelity を構築値として伝える。 |
| `src/game/dynamic/dynamic-entity/debris-reaction.ts` | coarse contact で module 単位の反応を要求しない契約を保つ。薬莢の物体間接触 callback は変更しない。 |
| `src/game/dynamic/dynamic-entity/enemy-motion.ts`、`src/game/ship/modular-ship-motion.ts` | 船体は初期段階で `exact` を明示し、surface LOD が船体へ漏れないことを固定する。 |
| `tests/game/dynamic-motion-shape.test.ts`、`tests/game/debris-reaction.test.ts` | opt-in 対象、船体 exact、保存復元後の既定、coarse contact の反応を検証する。 |
| `tools/bench/surface-contact-lod.mjs` | opt-in 前後を同一シナリオで比較し、section時間・exact/coarse件数・coarse早期接触距離を出す。 |

**達成条件と検証**

- x4096 では全 participant が exact、x65536 では opt-in 一時物体だけが coarse になる。
- `SECTION.celestialContact` がベースライン比 30% 以上短くなる。届かない場合は宇宙船を無断で coarse にせず、計測結果をもとに別計画を起こす。
- coarse participant の早期接触距離が仕様で定めた許容誤差以内で、対象外の物体の contact event・反発・温度が変わらない。
- `npm run bench:surface-contact-lod`、`npm run typecheck`、`npm run test:physics`、`npm run test:game`、`npm run check:boundaries`、`git diff --check`。

#### 手順6. コードレビュー、バグ調査、統合

**目的**

LOD の境界で exact/coarse が入れ替わる箇所、予測弧との不整合、proxy の false negative、別の接触経路への漏れを点検してから統合する。

**変更が必要な箇所**

| ファイル | 変更内容 |
| --- | --- |
| 変更された全 `src/physics/` / `src/game/dynamic/` | `DEVELOP/CODING-RULE.md` と `DEVELOP/ARCHITECTURE.md` を適用し、ゲーム種別分岐・physics からの速度管理 import・可変設定の越境を除く。 |
| `tests/physics/surface-contact.test.ts`、`tests/game/surface-contact-lod.test.ts` | 次の6ケースを固定する: 直線通過、接線、移動天体、回転途中、開始時内部、LOD境界の切替。 |
| `memos/mikanixonable/surface-contact-lightening-plan_2026-09-20.md` | 実測値、採用した対象、発見したバグ、未採用の宇宙船LOD・substep変更を追記する。 |

**達成条件と検証**

- exact participant の結果比較、coarse participant の許容誤差、preview/actual の整合、同時接触 tie-break をレビューで確認する。
- `npm run typecheck`、`npm run test:physics`、`npm run test:game`、`npm run check:boundaries`、`git diff --check` を統合前後に実行する。
- 専用 worktree で実装・レビュー・文書更新を行い、`workspace3` の未コミット変更を確認してから専用ブランチを統合する。別作業のファイルは stage しない。
- 統合 commit を確認後、今回作成した worktree・一時ブランチだけを削除する。

### 見積り

- 手順1: SPEC 2ファイル + 単独 commit 1件。実装を伴わないため、検証は文面レビューと差分検査。
- 手順2: 計数フィールド `5〜7` 個 × `surface-contact-physics` / `simulator` / `PerfCounts` / debug窓の4経路 + 固定ベンチ1本。計測値は x4096 / x65536 各100フレーム以上で取得する。
- 手順3: mode の受け渡し `Game → DynamicSystem → Simulator → SurfaceContactPhysics` の4境界 + participant の読み取り面1つ。全参加者 exact のため、結果差分はゼロが合格条件。
- 手順4: sphere geometry の候補数を `P`、subdivisionを `S` とすると、coarse path は `O(P)`、従来 exact path は `O(P × S)`。追加コストは coarse hit 時の既存 response 1回だけと見積もる。
- 手順5: 実測の削減効果は `Δms = baseline celestialContact ms - coarse celestialContact ms`、削減率は `Δms / baseline ms` で算出する。目標は 30% 以上。
- 手順6: 回帰6ケース × exact/coarse 2モード + 統合前後の検証一式。失敗ごとに該当層のテストを再実行する。

### リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 時間加速を physics が直接読む | フレームの速度段と接触判定がずれ、層境界を破る | 手順3の `rg` 検査、boundary check |
| coarse proxy が exact shape を内包しない | 一時物体が天体をすり抜ける | 手順3の構築検証、手順4の false-negative テスト |
| coarse の早期接触を許容値なしで返す | 物体の消失時刻が大きく前倒しになる | 手順1の仕様レビュー、手順5の距離計測 |
| coarse participant に surface callback や予測弧を許す | module反応・表示予測・実際の消失が食い違う | 手順3の構築拒否、手順5のゲーム回帰 |
| surface LOD を entity contact に配線する | 物体どうしの exact 接触が球近似へ変わる | 手順4の import/呼び出しレビュー、物体接触回帰 |
| `simSpeed <= 4096` の exact を崩す | 通常の再突入・操作中の結果が変わる | 手順5の速度段別テスト |
| 薬莢の物体間接触を surface LOD で解決しようとする | 高倍率で無効な経路を復活させ、負荷と仕様が混ざる | 手順5の対象範囲レビュー |
| coarse 時も substep を削る | 大気抵抗・加熱・姿勢の積分が粗くなり、別のバグになる | 手順3〜5の `SUBSTEP_MAX_COUNT` 差分レビューと回帰 |
| debug計数の追加が hot path の負荷を増やす | 改善値を計測コード自身が汚染する | 手順2の計測ON/OFF比較 |
| LOD導入だけで目標を達成できない | 宇宙船を無断近似しても負荷問題が残る | 手順5の30%ゲート。未達なら別計画へ戻す |

### 今回の計画に含めないもの

- 宇宙船の exact surface contact を high-warp で coarse へ切り替えること。船体の到達時刻、焼失、module反応への影響を別途評価する。
- `SUBSTEP_MAX_COUNT` の縮小、天体接触の更新スキップ、物体間接触の高倍率再有効化。
- sphere proxy を entity contact や選択判定の正確な形状へ置き換えること。
