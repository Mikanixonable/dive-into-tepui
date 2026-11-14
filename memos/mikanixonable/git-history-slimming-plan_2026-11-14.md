# git 履歴のスリム化 — 実行計画

計測時点: commit `a1e15167a`(devin/dev, 2026-11-14)。`.git` 564MB → `git gc --aggressive` 済みで 423MB。
blob の pack 占有合計は約 418MB。そのうち現ツリーに残らない死に重みが約 180MB。

## 目的

現ツリーにも将来使う見込みにも無い大きな blob を全ブランチの履歴から `git filter-repo` で除去し、
`.git` を 423MB → 約 250MB 前後まで縮める。

## 決めたこと

- **protein 系アセットは対象外。** `src/assets/models/` 配下の `*Structure*.json` / `*Motion*.json`
  (atpSynthase6n2y・pdb5i4r・rubisco8ruc、pack で約 49MB)は将来復活する可能性があるため履歴に残す。
- **実行タイミングは統合節目。** 全 worktree の作業が commit 済みで、活動中ブランチが main へ
  統合された直後にやる。未 commit の作業があるまま実行すると、その差分は残るが属していた
  ブランチ先端が別の SHA へ書き換わり、rebase の手間が増える。
- `ship-modules.glb`(pack で約 41MB / 69 版、差分圧縮済み・現役アセット)は**通常の対象外**。
  ファイルの履歴を失ってでも削るかは、実施時にユーザーへ問う(手順 4 の分岐)。

## 除去対象(計測時点の packed 占有)

| 対象 | packed | 根拠 |
| --- | --- | --- |
| `docs/` | 約 72MB | ビルド出力の過去 commit 分。現在 `.gitignore` 対象でツリーに無い |
| `.cloud-lab-shots/` | 約 51MB | 実験撮影 PNG。追跡は commit `b7576dbf0` で解除済み |
| `src/assets/orbits/lagrange-orbits*.json` | 約 36MB | 現ツリーに無い。ツリーに残すのは `origin/worktree-refactor-camera-frame` のみ |
| `src/assets/models/shipModules.json` | 約 8MB | `ship-modules.glb` とは別の旧形式ファイル。削除済み |
| `scratch/` | 約 6MB | 追跡は commit `d84c74db8` で解除済み |

合計 約 173MB。**protein 系は上表に含めない。**

## 達成目標

- `git count-objects -vH` の size-pack が 300MB を切る。
- 除去対象パスが `git log --all -- <path>` でヒットしない。
- リモートへも同じ死に重みが残らない(次回 fetch で復活しない)。
- `npm run build` と `npm run typecheck` が通る。

## 手順

### 手順 1. 前提の確認

目的: 書き換えは全 ref を巻き込むので、進行中の作業を安全な状態にしてから始める。

- 全 worktree が `git status` でクリーンであること(未 commit は commit か stash)。
  2026-11-14 時点では `.claude/worktrees/cloud-cells` に未 commit 2 件があった。
- `git worktree list` と `git branch` を出し、書き換え対象の ref 一覧を記録する。
- 他のエージェントへ「履歴を書き換えるので、未 push の作業は push/統合するか差分を保存しておく」と連絡する。
- 達成条件: 未 commit 0 件、連絡済み。

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
- 実行コマンド:

```sh
git filter-repo \
  --path docs/ \
  --path .cloud-lab-shots/ \
  --path-glob 'src/assets/orbits/lagrange-orbits*.json' \
  --path src/assets/models/shipModules.json \
  --path scratch/ \
  --invert-paths
```

- 達成条件: `git log --all -- docs/` が 0 件。`npm run typecheck` が通る。

### 手順 4. ship-modules.glb の履歴削減(任意・実施時に要確認)

目的: 69 版の履歴 blob が pack で約 41MB を占める。現版だけ残すなら約 25〜30MB 削れる。

- 方法: 現行ファイルをリポジトリ外へ退避 → filter-repo で `--path src/assets/models/ship-modules.glb
  --invert-paths` → 書き換え後の先端へファイルを戻して commit。
- 失うもの: このファイルの全履歴・blame。得るもの: 約 25〜30MB。
- 実施するなら手順 3 と同じ filter-repo 実行へ `--path` を足して 1 回にまとめる。

### 手順 5. リモート側の処理

目的: リモートに古い履歴が残ると、次回 `git fetch` で死に重みが全て復活して意味が無い。

- `git remote prune origin` で既にリモート側から消えた追跡 ref を掃除。
- 残る `origin/*` は2択:
  - **A. 書き換えた全ブランチを force-push**(`git push --force --all` + `--tags`)。他エージェントの
    ブランチ(muse/dev・workspace2/3/4 等)も書き換わっているので、各エージェントは rebase か
    再 clone が要る。
  - **B. 死に重みを抱えるリモートブランチを削除**し、残りだけ force-push。
- 達成条件: `git fetch` しても `.git` が膨らまない(`count-objects` の size-pack が維持される)。

### 手順 6. 後処理と検証

- `git reflog expire --expire=now --all && git gc --aggressive --prune=now` で孤児オブジェクトを落とす。
- worktree は旧 SHA を指したままなので、全て `git worktree remove` して必要なものを張り直す。
- `npm run build` / `npm run typecheck` で HEAD の健全性を確認。
- 達成目標の 4 項目を全て確認する。

## 見積り

- `.git`: 423MB → 約 250MB(手順 4 もやれば約 220MB)。
- 作業自体は filter-repo 1 回で数分。周囲の連絡・統合待ちが支配的なコスト。

## リスクと落とし穴

- **他エージェントが旧ブランチを push すると死に重みが復活する。** 実行前後で必ず周知する。
  `origin/*` を残したまま書き換えだけしても fetch で元に戻る — リモート処理(手順 5)は省略不可。
- **commit SHA が全て変わる。** 過去のメモや会話に書かれた SHA 参照はリンク切れになる
  (バックアップから `git show` で拾うことは可能)。
- **worktree の未 commit 差分はファイルとしては残るが、属していたブランチ先端は消える。**
  実行前に全 worktree をクリーンにする(手順 1)。
- `filter-repo` は remote を消す副作用がある — 実行後に `git remote add origin <URL>` で戻すのを忘れない。
- 計測値は 2026-11-14 時点のもの。実施時に `git verify-pack -v` で再計測してから対象を確定する。
