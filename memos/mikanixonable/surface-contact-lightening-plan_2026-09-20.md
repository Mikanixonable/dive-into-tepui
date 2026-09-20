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

実装後に、ここへ以下を追記する。

- 専用 worktree / ブランチ名と commit 列
- 項目1〜4の実装結果と、予定から変えた判断
- コードレビューで見つけた指摘と修正 commit
- バグ調査の再現条件、原因、修正、再検証結果
- `npm run typecheck` / `npm run test:physics` / `npm run test:game` / `npm run check:boundaries` / `git diff --check` の結果
- `workspace3` 統合 commit と worktree / 一時ブランチ削除結果
- 項目5〜6を残した理由と、次に測るべき負荷計測点
