# コミットメッセージの日本語化 — 実行計画

計測時点: commit `1ab54ea45`(workspace3, 2026-11-19)。HEAD で 9,088 commits。
前提となる履歴書き換えの手順・教訓は `memos/mikanixonable/plan-done/git-history-slimming-plan_2026-11-14.md`
(実施済み)が出典。本計画はその方式を流用し、除去対象をメッセージの書き換えへ変えたもの。

## 目的

過去の英語コミットメッセージを日本語へ翻訳し、AGENTS.md の Commit Message規約
(「プレフィックス以外は日本語を第一言語とする」)を既存履歴へも適用する。

AGENTS.md に「既存commitのmessage修正は避ける(force pushのリスク)」とあるが、本計画は
**ユーザー承認済みの一回限りの例外**とする。規則そのものは残し、日常の message 修正禁止は継続する。

## 決めたこと

- **merge/bot は対象外(ユーザー決定)。** `^Merge ` で始まる件名、dependabot・github-actions・
  copilot の author、件名が `bump ` を含む機械的依存更新は書き換えない(英語のまま残る)。
- **書き換え対象は「メッセージ全体が英語」のコミット。** 件名・本文ともに CJK(ひらがな・
  カタカナ・漢字)を1字も含まない人の手の非mergeコミット。**実測 1,503 件・本文込みで
  約 90.5K 字・最大 1,552 字**(2026-11-19 時点、HEAD 基準)。
  - `merge` `add docs` `wip` のような短文も人の手のコミットなので翻訳する。
- **件名が日本語で本文だけが英語のもの(実測で確定、おおむね 500〜600 件)は本文を翻訳する。**
  「メッセージを全て日本語に」の目的に含まれると判断した。**ユーザーの判断で外せる** —
  外すなら手順 2 の対象表と手順 4 の翻訳テーブルから除外するだけでよい。
- **日英混在のメッセージ(どこかに CJK がある英語多めのもの)はそのまま残す。** 部分的な
  書き換えは誤訳リスクが高く、規約適合と見なせる。
- **Conventional の `type(scope):` プレフィックスは英語のまま残す。** 規約は「プレフィックス以外
  を日本語」と定める。件名の本文部分・body を翻訳する。
- **trailer は1文字も変えない。** `Co-authored-by:`・`Signed-off-by:`・`Refs: #NN`・
  `Generated with ...` 等の行は翻訳対象から除外し、verbatim で保持する。
- **メッセージ中の SHA・ブランチ名・ファイルパス・識別子は翻訳しない。** リンク切れと
  意味変化を防ぐ。
- **書き換える ref は全 ref。** 一部のブランチだけ書き換えると、残った古い ref 経由で
  英語履歴が生き続ける。スリム化のときと同じく、消してよいブランチを先に整理してから実行する。
- **実行タイミングは統合節目。** 全 worktree が commit 済みで、活動中ブランチが main へ
  統合された直後にやる(スリム化計画と同じ理由)。

## 変えない挙動

- **全コミットの tree 内容は1バイトも変えない。** メッセージ以外のメタデータ(author/committer
  の名前・メール・日時)も変えない。書き換えは `commit.message` のみ。
- merge/bot コミットのメッセージは1文字も変えない。

## 達成目標

- 人の手の非mergeコミットで「件名・本文ともに CJK を含まない」メッセージが **0 件**。
  (検証: 手順 1 で確定した対象表と同じ検査を新 HEAD へ当てて 0 件になること)
- 書き換え前後で **全コミットの tree が一致**(差分 0)。バックアップ ref と新 ref を
  `git diff` して空であること。
- merge/bot コミットのメッセージが書き換え前と一致(件数と内容)。
- リモートへも新履歴だけが残る(次回 `git fetch` で旧履歴が復活しない)。
- `npm run typecheck` と `npm run build` が新 HEAD で通る。

## 手順

### 手順 0. ブランチ棚卸しと前提の確認

目的: 書き換えは全 ref を巻き込む。死にブランチが残ると英語履歴がその ref 経由で生き続け、
未 commit の作業は取り残される。

- 全 worktree が `git status` でクリーン(未 commit は commit か stash)。
- `git worktree list` と `git branch -a` を出し、残す ref・消す ref の一覧を記録する。
  消すブランチは実行前に削除する。
- 他のエージェントへ「履歴を書き換えるので未 push の作業は push/統合するか差分を保存」と連絡する。
- 達成条件: 未 commit 0 件、連絡済み、対象 ref 一覧の記録。

### 手順 1. 対象の確定と計測

目的: 翻訳対象の完全なリストを SHA 単位で固定する。分類は機械的に決める。

- HEAD の全コミットを3分類へ振り分ける検査スクリプトを作る:
  1. **除外** — `^Merge `、dependabot/github-actions/copilot author、`bump ` を含む件名。
  2. **対象A(本文ごと翻訳)** — メッセージ全体に CJK なし。
  3. **対象B(本文だけ翻訳)** — 件名に CJK あり・本文に CJK なし。
- 件数と文字量を本計画へ追記する(対象A は実測 1,503・約90.5K字が出発点)。
- 達成条件: 3分類の件数と対象SHAの一覧ファイルが確定する。

### 手順 2. バックアップ

目的: 書き換えは不可逆。元に戻せる完全複製をリポジトリ外へ置く。

- `git clone --mirror <repo> <repo外>/dive-into-tepui-msg-backup-YYYYMMDD.git`
  または `git bundle create <repo外>/backup.bundle --all`。
- 達成条件: バックアップ先で `git rev-list --all --count` が元と一致する。

### 手順 3. 翻訳テーブルの作成とレビュー

目的: `old_sha → 日本語メッセージ` の対応表を作り、品質を検査してから書き換えへ進む。

- 対象SHAのメッセージを dump し、バッチで翻訳する(分量が多いので委譲する:
  `/delegate-devin` で SWE-2 へ分割)。**trailer 行・プレフィックス・SHA・識別子は
  翻訳しないことを指示に明記する。**
- 出力は `tools/` 配下などへの JSON(`{old_sha: new_message}`)。**このテーブルは
  書き換え後も残してよいか、用済みで消すかは実施時に決める**(SHA対応表として有用だが
  リポジトリへ残す義務はない)。
- 機械検査: 全対象SHAに訳文がある・`type(scope):` プレフィックスが一致・trailer 行が
  verbatim・訳文に CJK がある・件名 50 字以内(規約)。
- 目視検査: ランダムに数十件と、最長のもの・`Refs:` 付きのものを抜き出して読む。
- 達成条件: 機械検査 0 エラー・目視で誤訳なし(あれば該当件を直して再検査)。

### 手順 4. filter-repo の実行(ローカル全 ref)

目的: テーブルの訳文でメッセージだけを書き換える。tree・author・日時は変えない。

- `git filter-repo` は `/opt/homebrew/bin/git-filter-repo` にインストール済み。
- worktree 付きでは `--force` が要る場合がある(スリム化で確認済み)。
- `--message-callback` は SHA を見られないため、`--commit-callback` で
  `commit.old_id` をテーブルへ引き `commit.message` を差し替える方式を取る。
  対象B は本文部分だけ差し替える分岐を入れる。
- 実行後 `git remote add origin <URL>` で remote を戻す(filter-repo は remote を消す)。
- 達成条件: バックアップとの `git diff` が全ブランチで空。対象Aが 0 件。
  `npm run typecheck` が通る。

### 手順 5. リモート側の処理

目的: リモートに旧履歴が残ると fetch で復活する。

- `git push --force --all` + `--tags`。他エージェントのブランチも書き換わるため、
  各エージェントは rebase か再 clone が要る(連絡は手順 0)。
- 達成条件: `git fetch` しても対象Aが復活しない。

### 手順 6. 後処理と検証

- `git reflog expire --expire=now --all && git gc --aggressive --prune=now`。
- 全 worktree を `git worktree remove` し、必要なものを張り直す。
- `npm run typecheck` / `npm run build` で新 HEAD の健全性を確認。
- 達成目標の5項目を全て確認する。

## 見積り

- 翻訳量: 対象A が約 90.5K 字、対象B がこれに加わる(手順 1 で確定)。この規模なら
  バッチ委譲で数回の分割で済む。翻訳コストが支配的で、filter-repo の実行自体は数分。
- 書き換え対象は 10,275 commits(全 ref)に対して message 差し替えのみ。
  前回のスリム化と同程度の実行時間を見通す。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 他エージェントが旧ブランチを push | 旧履歴が復活し作業が無駄になる | 手順 0(連絡)・手順 5 |
| `origin/*` を残したまま書き換える | fetch で旧履歴が戻る | 手順 5 |
| commit SHA が全て変わる | メモ・会話・計画書中の SHA 参照がリンク切れ | 手順 2(バックアップから `git show` で拾える) |
| worktree の未 commit 差分 | 差分は残るが属していたブランチ先端が消える | 手順 0 |
| 誤訳・文脈の読み違い | 履歴の意味が変わる | 手順 3(機械検査・目視) |
| trailer 行や `Refs:` を翻訳してしまう | ツール連携・参照が壊れる | 手順 3(trailer verbatim 検査) |
| 対象B の「本文だけ」差し替えで件名を巻き込む | 日本語件名が二重処理で変質 | 手順 4(差し替え分岐の確認)・手順 6(diff) |
| filter-repo が remote を消す | push 先を失う | 手順 4 後に `git remote add origin` で戻す |
| 実行中に別セッションが commit/push | その commit は書き換え範囲外 | 手順 0(全 worktree クリーン・停止確認) |

## 実施記録(2026-11-19 完了)

### 実測値

- 対象A(全文英語・人の手・非merge): **1,946 commits・150,963字・ユニーク 1,277 メッセージ**
- 対象B(件名JP・本文EN): **35 commits・6,704字** — 予想の 500〜600 件より大幅に少なかった
- 除外(merge/bot): 768 commits。日英混在スキップ: 7,531 commits
- 翻訳: ユニーク 1,302 メッセージを6バッチへ分割し、SWE-2 サブエージェントへ委譲

### 手順ごとの結果

- 手順 0: 計画 commit 後に全 ref 走査。`pre-ja-rewrite-backup` タグ(2026-08-20 調査の
  残り)を発見 — やはり以前準備されていたが、計画書本体は残っていなかった
- 手順 1: `tools/commit-message-ja/classify.mjs` で3分類。実行中に別セッションが
  workspace3 を進めたため、書き換え直前に再集計した値を権威とした
- 手順 2: `~/lab/dive-into-tepui-msg-backup-20261119.git` へ mirror バックアップ
  (10,280 commits・元と一致)。全 ref の先端+tree を `/tmp/ja-rewrite-refs-before.txt` へ記録
- 手順 3: 機械検査エラー実質1件(trailer 改変 m1113)を修正、prefix 指摘10件は
  `add:` `update:` 等の非規約擬似prefixで全体翻訳が正しい挙動。目視検査良好
- 手順 4: `git filter-repo --commit-callback` で `commit.old_id`→msgmap 引き。
  **58 ref 検査・tree 不一致 0・map 欠損 0**
- 手順 5: **2度の race が発生**(下記)。最終的にリモート 33/33 ブランチが書き換え済み
  SHA で定着。`release` は CI 競合で lease 拒否→新 deploy commit を graft して再 push
- 手順 6: worktree 4箇所すべてクリーン・新SHA上。`npm run typecheck` 合格

### 残存英語(意図的に未翻訳)

分類器が A=26・B=25 を残したが、全件検査の結果すべて**構造的に翻訳不能**:
`# Conflicts:` ブロック、ブランチ名・ファイルパス列挙、識別子のみの件名(`UI` 等)、
生成 trailer。自然言語の残存英語は 0。

### 発生した race(記録)

1. **書き換え中の進行**: 別セッションが main=PR#193・release=CI deploy・dependabot・
   feat/slimming-ui-fixes に新コミットを積んだ。第2パスの部分書き換えでは祖先の
   SHA がずれることが判明したため、**第1パスを権威として新規5コミットを
   `git commit-tree` で graft** して統一した
2. **旧履歴の再 push**: 初回 push 直後、別セッションが stale な clone から bulk push
   し、リモート 29/33 ブランチが旧 SHA へ巻き戻った。lease 付きで再 push して定着。
   **教訓: この種の作業は他の全セッション・clone を止めてからやるべき。** 手順 0 の
   「連絡」だけでは不十分で、stale clone からの `--all` push が全てを台無しにする
3. **release の CI 競合**: push 中に GitHub Actions が deploy commit を追加。
   lease が正しく検出したので、新 commit を書き換え済みチェーンへ graft して再 push

### 残したもの

- バックアップ: `/Users/pandeaconica/lab/dive-into-tepui-msg-backup-20261119.git`
- ツール+監査表: `tools/commit-message-ja/`(スクリプト4本と msgmap.json=原文→訳文の
  全対応表。in/out/ 等の中間生成物は削除)
- SHA対応: `.git/filter-repo/commit-map`(ローカルのみ)
