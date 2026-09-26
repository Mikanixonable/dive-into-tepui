# AGENTS.md

このリポジトリで作業するときの**進め方**を定める。ゲームの仕様は `DEVELOP/SPEC/`、コードの
書き方は `DEVELOP/CODING-RULE.md`、置き場と繋ぎ方は `DEVELOP/ARCHITECTURE.md` が正本で、ここには書かない。

## 文書の運用規則

**コードの現状はコードだけが原本。** 「いまどう動いているか」を説明する文書は作らない。
コードを読めば分かることを文書へ書き写した瞬間、それは次の変更で嘘になり、context を圧迫する
だけの負債になる。保持関係や呼び出し順が知りたければ、その場でコードから調べる。

**`DEVELOP/SPEC/` は「どう振舞うべきか」の原本であり、常にコードより先行する。**

- **SPEC/ を開くのは、これから作るものを決めるときだけ**(`/modify-feature`)。書き終えてから
  コードを書く。**実装を終えたあとに SPEC/ を見に行って突き合わせることはしない。**
- **未実装の記述が残っているのは正常な状態である。** 仕様と実装が一致することを目標にしない。
- **コードの現状を知るために SPEC/ を読まない。** 現状はコードから調べる。
- **書き方の規則は `DEVELOP/SPEC/README.md` が正本。** ここには書かない。

**`DEVELOP/CODING-RULE.md` はコードを編集するとき常に参照する。** 設計方針・命名規則・
コメント規約・テストとデバッグコードの正本。既存コードに残る違反を、規則を弱める根拠にしない。

**`DEVELOP/ARCHITECTURE.md` は層・境界・繋ぎ方の規則の正本。** いつ読むかは CODING-RULE 1.3 が
決める。**機能はまず規則どおりに分ける。** 分けられないときは理由を書いて例外にし、報告に
挙げる — 規則と判定を書き換えて通さない。規則を変えるのはユーザーが始める再設計だけ(ARCHITECTURE
「規則に合わないとき」)。

**`memos/` 以下は、指示があったときだけ書き換える。** 指示がなければ読むだけにする。
検討の経緯・進行中の todo・人間の開発ノートが置かれていて、どれも書き手が管理している。

## SKILL は自分から起動する

ユーザーが `/xxx` と打たなくても、状況に当てはまる SKILL は**自発的に実行する。**

| 状況 | 起動する SKILL |
| --- | --- |
| 段取りが要る規模の変更を任された | `/write-and-run-plan`(自分で監査し、最後まで実施する) |
| ユーザーが「計画を書いて」と明示した | `/write-plan`(書いて止まり、検査を待つ) |
| ユーザーが検査した計画ファイルのステップを実施する | `/run-plan` |
| サブエージェントへ作業を配る | `/delegate`(配る前に) |
| 機能の追加・変更・削除を要求された | `/modify-feature`(書き始める前に) |
| 調査(コードベース・文献)を要する大規模な機能追加を任された | `/add-feature`(要件定義書/実装計画書を書く。書き始める前に) |
| HUD/UI/DOM/CSS に触れる | `/ui-design`(書き始める前に) |
| 描画(`src/render/`・シェーダ)に触れる / 見た目を目で確かめる | `/rendering-workflow` |
| 大きな変更を終えた / 規約からの逸脱が疑わしい | `/refactor` |
| 大規模な変更のあと、コメントを一括点検する | `/comment-cleanup` |
| main へ PR を送る / main へ直マージする | `/send-pr`(取り込み・点検・検証・本文まで) |
| どこで何が起きているか当たりを付けたい | `/overview` |
| 誰が状態を持っているか / どこで `new` されるか | `/ownership` |
| いつ・どの順で・どんな条件で走るか(per-frame) | `/callstack` |
| 誰がその関数を呼んでいるか / 消せるか・影響範囲はどこか | `/inv-callstack` |
| 実行時の動作確認を求められた | `/verify` |
| タンパク質の追加を求められた | `/add-protain` |

**「計画を書いて」と明示されない限り、実行まで完遂する。** 段取りのために計画を書くと自分で決めた
のなら、書き先を決めるのも、判断材料を仕様・コード・実測から集めて計画を監査し直すのも、全手順を
実施して用済みのファイルを消すのも自分の仕事 — その途中でユーザーへ問い返さない。決めた判断は
終わったあとに報告し、ユーザーはそこで覆す。

`/ownership` `/callstack` `/inv-callstack` は、どれも**調査範囲(中心と深さ)を先に
ユーザーへ問う** — 全体を出力しても読めない。結果は既定では会話にだけ出し、**呼び出し主が
保存先を指定したときだけ**文書(典型的には計画書の md)へ残す。残すときは
`git rev-parse --short HEAD` を添えて**いつの時点のスナップショットかを明示する** — 明示
できないなら残さない。図の形と残し方は `.claude/skills/CODE-SNAPSHOT.md` が正本。

## サブエージェントは自分から使う

ユーザーが指示しなくても、**当てはまる場面ではサブエージェントを使う。** 目的は context の分離 —
本体の context を広い読み取りで埋めずに済ませ、独立した作業を並行させるためにある。

**使う場面**

- 広い走査の結論だけが要る — 識別子の全参照、命名ゆらぎを含む横断調査。
- 判断の余地がない一括編集 — 旧名の一括置換、コメントの一括点検。
- 計画のステップが互いに独立していて、並行できる。

**使わない場面**

- 読むファイルが1〜3個に絞れている — 文脈を再導出させるほうが高くつく。
- 仕様の確定・共通化の可否・ユーザーへの問い — 判断そのものが仕事なので委譲できない。
- 同じファイルを複数のエージェントが触ることになる — 競合する。

**配り方と、受け取ったあとのレビューは `/delegate`。**

## 作業のルール

- **検証は変更箇所に対応させる。** 既定は `npm run typecheck` のみで、これは常に走らせる。
  回帰テストは触った層のものだけ — `src/physics/` なら `npm run test:physics`、以下同様に
  `test:math` / `test:game` / `test:render`。ヘッドレス実行検証(`/verify`)は
  ユーザーが実行時の動作確認を明示的に求めたときだけ。変更と無関係な検証に時間を使わない。
  **例外は main へ送るとき** — そのときだけは変更箇所によらず全部回す(`/send-pr`)。

## ブランチと main へのマージ

`main` が開発最新版、`release` が安定版(公開されるもの)。`release` は main への push を受けた
CI が生成するので、**手で触らない。** 変更は main / release 以外のブランチで行い、PR で main へ
入れる(小規模なら直マージ)。

**main へ送るときの手順は `/send-pr` が正本。**

### ブランチ命名規則

新規ブランチ作成時は以下のプレフィックスを使用する:

| プレフィックス | 用途 | 例 |
| --- | --- | --- |
| `feat/` | 新機能 | `feat/cloud-meteorological-model` |
| `fix/` | バグ修正 | `fix/ship-docking-interference` |
| `refactor/` | リファクタリング | `refactor/cloud-architecture` |
| `perf/` | パフォーマンス改善 | `perf/render-pipeline` |
| `docs/` | ドキュメント | `docs/api-reference` |
| `test/` | テスト追加・修正 | `test/cloud-thermodynamics` |
| `chore/` | その他作業 | `chore/dependency-update` |
| `wip/` | 作業中（一時的） | `wip/experiment-xyz` |

**ルール:**
- 既存ブランチの改名は行わない（別エージェント作業中のため）
- 新規ブランチは上記規則に従う
- マージ完了後はローカル・リモート両方でブランチを削除
- 日本語のブランチ名は避ける（ASCII推奨）

### Commit Message規約

Conventional Commitsに従い、**日本語を第一言語**とする:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**type（プレフィックス）:**
- `feat`: 新機能
- `fix`: バグ修正
- `refactor`: リファクタリング
- `perf`: パフォーマンス改善
- `docs`: ドキュメント
- `test`: テスト追加・修正
- `chore`: その他作業
- `style`: コードスタイル（ロジック変更なし）

**scope（対象）:**
- 変更対象のモジュール・ファイル・機能（省略可）
- 例: `cloud`, `ship`, `render`, `physics`

**subject（件名）:**
- 簡潔な説明（日本語）
- 50文字以内
- 文末に句点「。」をつけない

**body（本文）:**
- 詳細な説明（必要な場合）
- 日本語で記述
- 「何を」「なぜ」「どう」を含める

**footer（フッター）:**
- 関連issue: `Refs: #123`
- Breaking Changes: `BREAKING CHANGE: 説明`

**例:**
```
feat(cloud): 気象モデルによる雲生成を追加

- 大循環による気圧・風・湿度の計算を実装
- 対流イベントのサンプリングと質量追跡を追加
- 球面上での輸送計算を追加

Refs: #45
```

```
fix(ship): ドッキング時のモジュール干渉を修正

モジュール配置時の干渉チェックを改善し、
不正な配置を防止するようにした。
```

**ルール:**
- プレフィックス以外は日本語を第一言語とする
- subjectは簡潔に、bodyは詳細に
- 1commitで1つの変更にする
- 既存commitのmessage修正は避ける（force pushのリスク）

### 定期的なメンテナンス

リポジトリの健全性を保つため、以下のメンテナンスを定期的に行う:

| 頻度 | 作業 | 手順 |
| --- | --- | --- |
| 月1回 | 古いブランチの削除 | `git branch --merged` でマージ済みブランチを確認し削除 |
| 月1回 | リモートブランチの整理 | `git remote prune origin` で削除済みリモートブランチを整理 |
| 四半期ごと | CI/CD設定の見直し | ワークフローの依存更新、テストカバレッジの確認 |
| 四半期ごと | 依存パッケージの更新 | `npm audit` で脆弱性チェック、`npm outdated` で更新確認 |

**手順:**
```bash
# マージ済みブランチの確認（main/releaseを除く）
git branch --merged main | grep -v "main" | grep -v "release"

# 古いブランチの削除（安全のため--dry-runで確認）
git branch --merged main | grep -v "main" | grep -v "release" | xargs git branch -d

# リモートブランチの整理
git remote prune origin

# 依存パッケージのチェック
npm audit
npm outdated
```

## コマンド

| コマンド | 用途 | いつ走らせるか |
| --- | --- | --- |
| `npm run typecheck` | 型検査 | **常に** |
| `npm run test` | 全層の回帰テスト | **main へ送る前**(`/send-pr`) |
| `npm run test:physics` | `src/physics/` の回帰テスト | `src/physics/` を触ったとき |
| `npm run test:math` | `src/math/` の回帰テスト | `src/math/` を触ったとき |
| `npm run test:game` | `src/game/` の回帰テスト | `src/game/` を触ったとき |
| `npm run test:render` | `src/render/` の回帰テスト | `src/render/` を触ったとき |
| `npm run dev` | 開発サーバ(http://localhost:8080) | 実機で動かすとき |
| `npm run smoke:browser` | ヘッドレスでの起動・操作スモーク | 実行時の確認を求められたとき |
| `npm run build` | `docs/` への本番ビルド | **main へ送る前**(`/send-pr`)。公開は CI が行う |
| `npm run ci` | 上記 + アセット・テーマ・リリース物の点検 | 任意。main へ送る検証は `/send-pr` |
| `npm run bgm-lab` | BGM の試聴環境(http://localhost:8081) | 曲を調整するとき |
| `npm run render-lab` | 描画の実験環境(http://localhost:8082) | 描画を目で確かめるとき |
| `npm run render-lab:shot` | 描画の実験環境の撮影(`.render-lab/shots/`) | 描画を画像で確かめるとき |
| `npm run cloud-lab` | 雲の実験環境(http://localhost:8083) | 雲の生成を目で確かめるとき |
| `npm run cloud-lab:shot` | 雲の実験環境の撮影(`.cloud-lab/shots/`) | 雲を画像で確かめるとき |
| `npm run cloud-lab:compare` | 生成と実写の統計比較(`.cloud-lab/compare/`) | 雲の生成を実写(8k_clouds)と見比べるとき |
| `npm run cloud-lab:separate` | 実写を被覆率・雲頂高度・薄い雲へ推定分離(`.cloud-lab/separated/`) | 実写から描画用の仮テクスチャを作るとき |
| `npm run export-assets` | `src/assets/` の焼き込みアセット再生成 | モデルかノズル表を変えたときだけ |

`npm run export-assets` は実行のたびに全アセットの識別子が振り直されるため、差分が識別子だけの
ファイルは commit せず戻す。

