# git 履歴のスリム化 — 実行計画

計測時点: commit `0dc1a148d`(workspace3, 2026-11-19)。`.git` の size-pack は **973.86MB**。
11/14 時点の 423MB から 5日で +550MB 増えており、再膨張は続いている。
現ツリー(HEAD)の blob 合計は非圧縮 169MB・1780 個 — **履歴が持つ重みは約 800MB**。

## 目的

現ツリーにも将来使う見込みにも無い大きな blob を全ブランチの履歴から `git filter-repo` で除去し、
`.git` を 974MB から 500MB 前後以下へ縮める。

## 決めたこと

- **protein 系アセットは対象外。** `src/assets/models/` 配下の `*Structure*.json` / `*Motion*.json`
  (atpSynthase6n2y・pdb5i4r・rubisco8ruc)は将来復活する可能性があるため履歴に残す。
- **`assets-src/` は対象外。** Blender 元データ(.glb 25個・現ツリーに生存)で、履歴も残す。
- **`ship-modules.glb`**(非圧縮合計 1.2GB・70版、現役アセット)は**通常の対象外**。
  現版だけ残して全履歴を捨てるかは、実施時にユーザーへ問う(手順 5)。
- **`CLAUDE.md` の全履歴除去**は現行ファイル(19.6KB)を別途再追加する方式で行う(手順 4)。
  620版・非圧縮 219MB の履歴を持ち、旧版は巨大だった。履歴の blame 価値は低いが、
  失うことを承知のうえで実施するか、実施時にユーザーへ問う。
- **実行タイミングは統合節目。** 全 worktree の作業が commit 済みで、活動中ブランチが main へ
  統合された直後にやる。未 commit の作業があるまま実行すると、その差分は残るが属していた
  ブランチ先端が別の SHA へ書き換わり、rebase の手間が増える。
- **不要ブランチを先に消す(手順 0 済)。** 死に重みを指す ref が残ると、filter-repo を通しても
  そのブランチの履歴ごと重みが保持される。filter-repo は全 ref を書き換えるので、
  消してよいブランチは実行前に整理しておく。
- **手順 0 実施済み(2026-11-19):** ローカル 29 本(main 完全マージ済み)・リモート 18 本を削除、
  stash 11 件を削除。残りはローカル 36・リモート追跡 28・stash 1 件。
  未マージの大きな固有履歴ブランチ(screenspace-temporal 等 6 本)はユーザーの判断で保持。

## 除去対象(計測時点、非圧縮 blob 合計)

「非圧縮」は `git rev-list --objects --all` + `cat-file --batch-check` の合計で、
pack 実占有より大きく出る(テキストは delta 圧縮が効く)。実施前に verify-pack で packed を再計測する。

| 対象 | 非圧縮 | 根拠 |
| --- | --- | --- |
| `src/assets/models/shipModules.json` | 約 245MB | 旧形式ファイル・全ブランチで削除済み(18版) |
| `CLAUDE.md` | 約 219MB | 620版・現行は 19.6KB。旧巨大版の履歴だけが重い(手順 6 で扱う) |
| `docs/` | 約 72MB(packed 旧計測) | ビルド出力の過去 commit 分。現在 `.gitignore` 対象でツリーに無い(397パス) |
| `memos/hedalu244/better_graphics/screenspace-diffuse.md` | 約 70MB | 176版・全ブランチで削除済み |
| `.cloud-lab-shots/` | 約 51MB(packed 旧計測) | 実験撮影 PNG。追跡解除済み(91パス) |
| `src/assets/orbits/lagrange-orbits*.json` | 約 80MB | 現ツリーに無い(8ファイル群) |
| `memos/mikanixonable/sessions/shots/` | 数 MB | セッション撮影 PNG・削除済み(24パス) |
| `scratch/` | 約 6MB(packed 旧計測) | 追跡解除済み(43パス) |

合計 非圧縮で約 740MB(packed 換算ではこれより小さい。実測が手順 1 で確定する)。
**protein 系・`assets-src/`・現ツリーに残るアセットは上表に含めない。**

## 達成目標

- `git count-objects -vH` の size-pack が **500MB を切る**(除去量の実測で更に下がれば追記する)。
- 除去対象パスが `git log --all -- <path>` でヒットしない。
- リモートへも同じ死に重みが残らない(次回 fetch で復活しない)。
- `npm run build` と `npm run typecheck` が通る。

## 手順

### 手順 1. 前提の確認と再計測

目的: 書き換えは全 ref を巻き込むので、進行中の作業を安全な状態にしてから始める。
また除去量は packed 実測で確定させる(非圧縮計測は上限でしかない)。

- 全 worktree が `git status` でクリーンであること(未 commit は commit か stash)。
- `git worktree list` と `git branch` を出し、書き換え対象の ref 一覧を記録する。
- 他のエージェントへ「履歴を書き換えるので、未 push の作業は push/統合するか差分を保存しておく」と連絡する。
- `git verify-pack -v` で除去対象パスの packed 占有を再計測し、除去対象表を確定・更新する。
- 達成条件: 未 commit 0 件、連絡済み、packed 実測値の記録。

### 手順 2. バックアップ

目的: 書き換えは不可逆なので、元に戻せる完全複製をリポジトリ外へ置く。

- `git clone --mirror <repo> <repo外>/dive-into-tepui2-backup-YYYYMMDD.git`
  または `git bundle create <repo外>/backup.bundle --all`。
- 達成条件: バックアップ先で `git rev-list --all --count` が元と一致する。

### 手順 3. filter-repo の実行(ローカル全 ref)

目的: 死に重みパスを全ブランチの履歴から除去する。

- `git filter-repo` は `/opt/homebrew/bin/git-filter-repo` にインストール済み。
- worktree 付きリポジトリではそのまま実行できない場合がある。そのときは
  `.claude/worktrees/*` を一時的に外すか、`--force` を付けて実行する(実施時に挙動を確認)。
- 実行コマンド(手順 1 の再計測で対象が増減したら `--path` を合わせて調整):

```sh
git filter-repo \
  --path docs/ \
  --path .cloud-lab-shots/ \
  --path-glob 'src/assets/orbits/lagrange-orbits*.json' \
  --path src/assets/models/shipModules.json \
  --path memos/hedalu244/better_graphics/screenspace-diffuse.md \
  --path memos/mikanixonable/sessions/shots/ \
  --path scratch/ \
  --invert-paths
```

- 達成条件: `git log --all -- docs/` が 0 件。`npm run typecheck` が通る。

### 手順 4. CLAUDE.md の履歴除去と再追加(推奨・実施時に要確認)

目的: 620版・非圧縮 219MB の履歴を捨て、現行の小さなファイルだけを残す。

- 方法: 現行 CLAUDE.md をリポジトリ外へ退避 → 手順 3 の filter-repo に
  `--path CLAUDE.md` を足して同時実行 → 書き換え後の先端へファイルを戻して commit。
- 失うもの: CLAUDE.md の全履歴・blame。得るもの: packed 実測次第(非圧縮 219MB が上限)。

### 手順 5. ship-modules.glb の履歴削減(任意・実施時に要確認)

目的: 70版の履歴 blob(非圧縮 1.2GB、packed は delta 圧縮で大幅に小さい可能性)を減らす。

- 方法: 現行ファイルをリポジトリ外へ退避 → filter-repo で `--path src/assets/models/ship-modules.glb
  --invert-paths` → 書き換え後の先端へファイルを戻して commit。
- 失うもの: このファイルの全履歴・blame。得るもの: packed 実測次第(手順 1 で数値を見て判断する)。
- 実施するなら手順 3/4 と同じ filter-repo 実行へ `--path` を足して 1 回にまとめる。

### 手順 6. リモート側の処理

目的: リモートに古い履歴が残ると、次回 `git fetch` で死に重みが全て復活して意味が無い。

- `git remote prune origin` で既にリモート側から消えた追跡 ref を掃除。
- 残る `origin/*` は2択:
  - **A. 書き換えた全ブランチを force-push**(`git push --force --all` + `--tags`)。他エージェントの
    ブランチ(muse/dev・workspace2/3/4 等)も書き換わっているので、各エージェントは rebase か
    再 clone が要る。
  - **B. 死に重みを抱えるリモートブランチを削除**し、残りだけ force-push。
- 達成条件: `git fetch` しても `.git` が膨らまない(`count-objects` の size-pack が維持される)。

### 手順 7. 後処理と検証

- `git reflog expire --expire=now --all && git gc --aggressive --prune=now` で孤児オブジェクトを落とす。
- worktree は旧 SHA を指したままなので、全て `git worktree remove` して必要なものを張り直す。
- `npm run build` / `npm run typecheck` で HEAD の健全性を確認。
- 達成目標の 4 項目を全て確認する。

## 見積り

- 除去量: packed 実測待ちだが、非圧縮で約 740MB が上限。テキスト系(shipModules.json・CLAUDE.md)
  は delta 圧縮が効くため packed 換算はこれより小さい。**size-pack 974MB → 約 450〜600MB**
  を見通しとする(手順 4/5 込みなら更に下がる)。手順 1 の verify-pack で確定させる。
- 作業自体は filter-repo 1 回で数分。周囲の連絡・統合待ち・ブランチ棚卸しが支配的なコスト。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 他エージェントが旧ブランチを push する | 死に重みが復活し作業が無駄になる | 手順 1(連絡)・手順 6 |
| `origin/*` を残したまま書き換える | fetch で旧履歴が戻る | 手順 6 |
| commit SHA が全て変わる | メモ・会話中の SHA 参照がリンク切れ | 手順 2(バックアップから `git show` で拾える) |
| worktree の未 commit 差分 | 差分は残るが属していたブランチ先端が消える | 手順 1 |
| 不要ブランチの残置 | その ref 経由で重みが保持され、除去が効かない | 手順 0・手順 1 の再計測 |
| 現行ファイルを誤って `--path` 指定 | 現ツリーからも消える | 手順 3(対象表の現ツリー残留チェック) |
| filter-repo が remote を消す | push 先を失う | 手順 3 後に `git remote add origin` で戻す |
| 実行中に別セッションが commit/push | その commit は書き換え範囲外になり旧履歴が残る | 手順 1(全 worktree クリーン・停止確認) |
| 再膨張 | 撮影物・生成物の再 commit で同じ問題が再発 | 手順 7 後(再発防止は別途検討: gitignore 監査・大容量 commit の検知) |
