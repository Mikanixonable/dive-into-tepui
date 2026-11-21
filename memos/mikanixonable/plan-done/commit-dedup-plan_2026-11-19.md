# 重複コミットの除去 — 実行計画

計測時点: 2026-11-19。前提: コミットメッセージ日本語化(plan-done/commit-message-ja-plan_2026-11-19.md)
が完了し、全履歴が日本語化済みの新 SHA 系。本計画はその次段の履歴書き換え。

## 目的

main の祖先内に、**同一差分(patch-id 一致)を持つコミットが平均2.4件・計 3,269 件**
(9,095 件中 36%)存在する。同一変更が複数の並行ブランチに別コミットとして記録され、
両方がマージされて残っているのが原因(書き換え前から存在する構造)。
各差分を履歴上1回だけにし、重複コミットを取り除く。

AGENTS.md「既存commitのmessage修正は避ける」への例外は前回同様**ユーザー承認済みの
一回限り**とするが、本計画はメッセージでなく **DAG 構造そのもの**を変える点でより大きい。

## 決めたこと

- **重複の定義は patch-id 一致。** `git show <c> | git patch-id --stable`。
  差分が同じ = 同じ変更。件名が違っても patch-id が同じなら重複と見なす。
- **正本(canonical)は各 patch-id につき1件だけ残す。** 残す側の選び方:
  1. main の first-parent 鎖上のコピー(本線の見た目を保つため)
  2. なければ committer date が最も早いコピー
  3. タイブレークは SHA の辞書順(決定的)
- **残りのコピーは `commit.skip()` で収縮除去** — 子コミットは除去コミットの親へ
  自動的に継ぎ直される(filter-repo 内蔵)。**全コミットの tree は1バイトも変えない**
  (skip は構造だけを変え、tree はそのまま)。その結果、除去された側線上の変更差分は
  残った最初の子孫コミットの表示 diff に吸収される — 内容は失われないが、
  そのコミットの件名と diff の対応は粗くなる(許容する)。
- **マージコミット・空差分コミット・ルート・ref 先端は対象外**として必ず残す:
  - マージは patch-id が空で重複判定できず、またトポロジーの記録として残す
  - 空差分(件名だけの commit 等)は「重複」でなく意図的なマーカーの可能性
  - ref 先端を skip するとブランチ内容が変わる → 先端は必ず残す
  - 片側線が全て収縮したマージは filter-repo が自動で片親化する(付随効果)
- **書き換える ref は全 ref**(前回同様: 一部だけだと残った ref 経由で重複が生き残る)。
- **バックアップは日本語化時のものを再利用しない** — 現在状態の別バックアップを取る。
  日本語化後の SHA は `.git/filter-repo/commit-map` と msgmap で旧 SHA へ追跡可能。

## 変えない挙動

- 全コミットの **tree・author/committer・日時・メッセージ**は不変。変えるのは DAG 構造のみ。
- 残る各コミットの内容はそのまま(除去される側の内容は正本側または子孫の diff に含まれる)。

## 達成目標

- 全 ref 先端の tree が書き換え前と一致(差分0)。
- main 祖先内の patch-id 重複が **正本を除き 0**(件数は実測で確定)。
- リモートに新履歴だけが残る。
- `npm run typecheck` が通る。

## 手順

### 0. 前提確認

- 全 worktree がクリーン・活動中ブランチが統合済みであること。
- **別セッションへの連絡は前回同様に限界がある**(stale clone の bulk push で
  巻き戻された前科がある)。push 直前にリモートを再 fetch して race を検出し、
  先行コミットは graft で継ぐ方式を前提とする。

### 1. 採寸と drop 集合の確定

- 全 ref 到達コミット(merge・空差分・root・ref先端を除く)の patch-id を採取。
- patch-id ごとに canonical を選び、**drop 集合(旧 SHA 一覧)を確定**する。
- 件数と代表例を本計画へ追記する。

### 2. バックアップ

- `git clone --mirror` をリポジトリ外へ(前回と別名)。

### 3. filter-repo の実行

- `git filter-repo --commit-callback` で `commit.original_id`(or old_id)が
  drop 集合に含まれる非mergeコミットへ `commit.skip()` を呼ぶだけの単純なコールバック。
- 実行後 `git remote add origin` を戻す。

### 4. 検証

- 各 ref: 新先端の tree == 旧先端の tree。
- drop 集合が到達不能になったこと、canonical が残っていること。
- patch-id 重複の再集計(目標0)、typecheck。

### 5. リモート

- `git push --force-with-lease` で全ブランチ + `--tags`。
- 先行コミットがあれば graft して継ぐ(前回と同じ機構)。

### 6. 後処理

- reflog expire + gc、worktree 健全性、結果を本計画へ追記して plan-done へ。

## リスク

| リスク | 影響 | 対処 |
| --- | --- | --- |
| 別セッションの bulk push | 旧履歴が復活 | push 直前に fetch・lease・graft |
| skip の継ぎ直しで diff 表示が膨らむ | `git log -p` で差分の帰属が粗くなる | 許容(tree・内容は不変) |
| patch-id が「同じ差分・別の意図」で衝突 | 意味の違うコミットが消える | patch-id は差分全体のハッシュのため稀。代表例を目視で確認 |
| 実行中の新規コミット | 書き換え範囲外 | graft で継ぐ(前回実績あり) |
| 9k コミット規模の skip 収縮 | 構造の破綻 | tree 一致検証 + バックアップ |

## 実施記録(2026-11-19 完了)

### 実測値

- 全 ref 到達コミット: 10,299 → **7,525**(収縮除去 2,774 件)
- main 祖先: 9,095 → **6,528**(−28%)
- 残存重複: 非マージ 0 組。**マージ同士の patch-id 重複 103 組のみ**
  (同じ取り込みが複数線で行われた記録 — 除去はマージのトポロジー手術が要るので残した)
- ツリー保存: 全 44 ref で先端 tree が書き換え前と一致(不一致 0)
- リモート: 39 ブランチが新履歴で定着、local-remote 差分 0

### 計画からの変更(重要)

**`commit.skip()` 方式は途中で破棄した。** filter-repo の skip は「記録された
tree」を保存せず、差分を新しい親へ**再適用**するため、未マージの古いブランチから
重複分の内容が実際に消えた(17 ref で先端 tree が変化、worktree 先端の内容を
巻き戻す副作用あり)。代わりに `commit-tree` による独自再構築を実装した:

- 保持コミットは元の tree・author・committer・message をそのまま使い、
  drop コミットは子の親を最近の保持祖先へ張り替える(収縮)
- 親リストの冗長辺(一方が他方の祖先)は除去 → 側線が全収縮したマージは
  自動的に片親化
- 実装: `tools/commit-dedup/rebuild.py`(cat-file --batch + commit-tree)

### 実行中の事故と対処

- 初回 rebuild で `refs/backup/`・`refs/stash` の先端が drop 集合に混入
  (drop 集合の「ref 先端」保護が heads/tags しか見ていなかった)。全 ref の
  先端を保護へ広げて再実行 → 失敗 0
- マージの patch-id 集計で `git show` の `--cc` 出力から patch-id が 2 行
  出る罠に遭遇(2 行目は全マージ共通の定数で偽の重複群)。先頭 1 行のみ採用に修正
- リモート main/release は書き換え中に進行(PR#195 マージ + CI deploy)。
  旧 DAG の像への付け替え + commit-tree graft で対応
- タグ `pre-ja-rewrite-backup` も新履歴上へ移動済み

### 残したもの

- バックアップ: `/Users/pandeaconica/lab/dive-into-tepui-dedup-backup-20261119.git`
  (書き換え直前の mirror)
- ツール: `tools/commit-dedup/`(build-drop-set.mjs・rebuild.py・dedup-callback.py)
- SHA 対応: `/tmp/dedup-image-map.json`(旧→新、ローカルのみ)
