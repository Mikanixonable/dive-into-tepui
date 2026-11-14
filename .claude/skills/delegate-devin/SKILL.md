---
name: delegate-devin
description: サブエージェントの作業を Devin CLI の SWE-2 に任せ、Claude のトークンを節約する手順。起動コマンド・effort・権限・worktree の要否を定める。指示の中身と受け取ったあとのレビューは /delegate が正本。サブエージェントを使うと決めた時点で、Claude の組み込みサブエージェントより優先して自発的に起動する
---

# Devin(SWE-2)へ配る

**目的は Claude のトークンを抑えること。** 手を動かす作業(実装・一括編集・広い調査)は SWE-2 に
させ、Claude は切り分け・判断・レビューだけを持つ。サブエージェントを使う場面は CLAUDE.md
「サブエージェントは自分から使う」、渡す指示の中身とレビューは `/delegate` に従う。ここにあるのは
Devin 固有の差分だけ。

Claude の組み込みサブエージェント(Agent ツール)は、Devin が使えないとき(認証切れ・起動失敗)の
代替にだけ使う。

## 起動

指示は scratchpad へ書き、ファイルで渡す。

```bash
devin -p --prompt-file <指示ファイル> --model swe-2-high --permission-mode accept-edits
```

- **調査だけ**なら `--permission-mode auto`(読み取り専用)。
- 数分かかる作業は Bash の `run_in_background` で走らせ、終わるのを待つ間に別の作業を進める。
- 作業ディレクトリは担当する worktree。Devin は `AGENTS.md` と `.claude/skills/` を自動で読むが、
  `DEVELOP/` 以下は読まないので、`/delegate` 2 のとおり名指しする。
- **報告は短くさせる** — 触ったファイル・判断した箇所・残したもの・検証結果だけ。長い報告は
  Claude のトークンを食う。

## effort

モデル名の接尾辞で選ぶ。迷ったら `swe-2-high`。

- `swe-2-medium` — 機械的な一括編集、調査
- `swe-2-high` — 通常の実装
- `swe-2-max` — 設計の絡む実装、high で通らなかったもの
- `-lightning` 付きは従量課金なので、ユーザーの許可なしに使わない

## 権限

`accept-edits` では編集は通るが、コマンド実行は許可リストにあるものだけ通る。許可リストは
`.devin/config.local.json`(git 管理外)の `permissions.allow` で、検証コマンドを足す。

- `smart` / `dangerous` は使わない — Claude Code の自動判定に監督の迂回として拒否される。
- `--sandbox` は使わない — `-p` では編集まで拒否される。

## Devin の子エージェント

Devin が自分の判断で子エージェント(`explore-swe2` / `general-swe2`)を使うのは構わない —
Claude のトークンは減る。ただし起動のたびに1分以上かかるので、小さな作業では使わせない。編集する
子同士にファイルを重ねさせないことを指示に含める。

## worktree

**worktree は競合を避けるためだけに使う。** 並行させる Devin 同士、または Devin と Claude 自身が
触るファイルが重ならないなら、同じ作業ツリーで並行させてよい。重なるときだけ worktree を分けるか、
直列にする。worktree を分けたときの統合と片付けは `/parallel-worktree-change` に従う。

## 受け取ったら

`/delegate` 4 のレビューを行う。トークンを抑えるため、まず `git diff --stat` で範囲外を触って
いないかを見て、差分の本文は変更箇所だけを読む(ファイル全体を開き直さない)。検証は自分で
もう一度通す。直しが要るなら、同じ Devin のセッションへ差し戻す(`devin -p -r <session id>` で会話を続けられる。
ID は `devin list` で引く)か、小さければ自分で直す。commit は Claude が行う。
