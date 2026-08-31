# CLAUDE.md

このリポジトリで作業するときの**進め方**を定める。ゲームの仕様は `DEVELOP/SPEC/`、コードの
書き方は `DEVELOP/CODING-RULE.md` が正本で、ここには書かない。

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
| どこで何が起きているか当たりを付けたい | `/overview` |
| 誰が状態を持っているか / どこで `new` されるか | `/ownership` |
| いつ・どの順で・どんな条件で走るか(per-frame) | `/callstack` |
| 誰がその関数を呼んでいるか / 消せるか・影響範囲はどこか | `/inv-callstack` |
| 実行時の動作確認を求められた | `/verify` |

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
  **例外は main へ送るとき** — そのときだけは変更箇所によらず全部回す(「ブランチと main への
  マージ」)。
- **共通化するかどうかは、参照箇所の数ではなく「今後も使う可能性があるか」で決める。** これは
  コードからは判別できないので、`DEVELOP/SPEC/` の該当ファイル末尾にある「未確定の案」節を見て、
  決まらなければユーザーに問う。ユーザーが可能性に言及したものは同節へ記録する。

## ブランチと main へのマージ

`main` が開発最新版、`release` が安定版(公開されるもの)。`release` は main への push を受けた
CI が生成するので、**手で触らない。** 変更は main / release 以外のブランチで行い、PR で main へ
入れる(小規模なら直マージ)。

**main へ入る時点で、CI が回す検証がすべて通っていなければならない。** CI
(`.github/workflows/build.yml`)は `npm run typecheck` → `npm run test` → `npm run build`
を順に回し、**どれか1つでも落ちれば deploy がそこで止まる** — `release` が更新されず、公開版が
古いまま取り残される。自動テストが回らない状態が常態化するのも困るが、**デプロイが止まったまま
常態化するほうがはるかにマズい。**

したがって:

- **main へマージする前・PR を送る前に、作業ブランチで `npm run typecheck` と
  `npm run test`(全層)を通す。** 触った層がどこであっても、**このときだけは必ず回す。**
  ローカルで通らないものを main へ送らない。
- **赤いまま main へ送らない。** 原因が自分の変更の外にあっても同じ — 赤いものを通した時点から
  先の deploy が全部止まる。自分の変更が原因でないなら、先にそれを直すか、**直さずに送る判断は
  ユーザーに委ねる**(黙って送らない)。

## コマンド

| コマンド | 用途 | いつ走らせるか |
| --- | --- | --- |
| `npm run typecheck` | 型検査 | **常に** |
| `npm run test` | 全層の回帰テスト | **main へ送る前** |
| `npm run test:physics` | `src/physics/` の回帰テスト | `src/physics/` を触ったとき |
| `npm run test:math` | `src/math/` の回帰テスト | `src/math/` を触ったとき |
| `npm run test:game` | `src/game/` の回帰テスト | `src/game/` を触ったとき |
| `npm run test:render` | `src/render/` の回帰テスト | `src/render/` を触ったとき |
| `npm run dev` | 開発サーバ(http://localhost:8080) | 実機で動かすとき |
| `npm run smoke:browser` | ヘッドレスでの起動・操作スモーク | 実行時の確認を求められたとき |
| `npm run build` | `docs/` への本番ビルド | 通常不要(公開は CI が行う) |
| `npm run ci` | 上記をまとめて通す | 大きな変更を締めるとき |
| `npm run bgm-lab` | BGM の試聴環境(http://localhost:8081) | 曲を調整するとき |
| `npm run render-lab` | 描画の実験環境(http://localhost:8082) | 描画を目で確かめるとき |
| `npm run render-lab:shot` | 描画の実験環境の撮影(`.render-lab/shots/`) | 描画を画像で確かめるとき |
| `npm run cloud-lab` | 雲の実験環境(http://localhost:8083) | 雲の生成を目で確かめるとき |
| `npm run cloud-lab:shot` | 雲の実験環境の撮影(`.cloud-lab/shots/`) | 雲を画像で確かめるとき |
| `npm run export-assets` | `src/assets/` の焼き込みアセット再生成 | モデルかノズル表を変えたときだけ |

`npm run export-assets` は実行のたびに全アセットの識別子が振り直されるため、差分が識別子だけの
ファイルは commit せず戻す。

### タンパク質を1体追加する

初回だけ Python の仮想環境が要る。`python3 -m venv .venv-protein-builder` のあと、
`.venv-protein-builder/bin/pip install --no-deps -r tools/protein-builder/requirements-lock.txt`
で入れる。**`--no-deps` が要る**: PyMOL の wheel は numpy を過剰に固定しているが、実際には新しい
numpy でも動く。使う Python は `PROTEIN_PYTHON` 環境変数で差し替えられる。

1. `assets-src/proteins/<id>/` に `protein.config.json` と `protein.definition.json` を置く。config
   には `pdbId`・`sourceStructureUrl`(RCSB の `.cif` の URL)・`sourceStructureFile`(取り込み先の
   リポジトリ相対パス)・`source`(backbone アセットの出力先)・`structureAsset`・`motionAsset`・
   `semanticAsset`・`definitionAsset`・`coordinateScale`・`surfaceQuality` を書く。
2. `npm run protein:fetch-source` で原構造 mmCIF を `sourceStructureFile` へ取り込む。
3. `npm run protein:backbone` で Cα 主鎖アセットを生成する。
4. `npm run protein:generate-structure` で全原子・共有結合・分子表面のアセットを生成する。
5. `npm run protein:generate` で semantic asset と残基 motion asset を生成する。backbone / structure
   を作り直したときは、motion が両者の内容ハッシュを参照しているため、**motion アセットも必ず
   作り直す**。作り直さないと読み込み時に不整合で落ちる。
6. `npm run protein:catalog` で登録カタログを更新する。
7. `npm run protein:validate`・`npm run protein:validate-structure`・`npm run protein:motion:validate`・
   `npm run typecheck`・`npm run render-lab:shot` を通す。生成されたアセットはクリエイティブステージの
   一覧へ自動的に現れる。

原構造を更新するときだけ `npm run protein:fetch-source` を走らせる。`npm run protein:fetch-source:check`
で寄託側の改訂を検出できる。

**どう見せるか・どう振舞うかは `DEVELOP/SPEC/PROTEIN.md`。** ここにあるのは生成の手順だけ。
