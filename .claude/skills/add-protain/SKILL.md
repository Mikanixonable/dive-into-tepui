---
name: add-protain
description: タンパク質アセットを1体追加する手順。原構造の取り込みから主鎖・全原子・残基 motion の生成、カタログ登録、検証までを順に通す。どう見せるか・どう振舞うかは DEVELOP/SPEC/PROTEIN.md が正本で、ここにあるのは生成の手順だけ。ユーザーがタンパク質の追加を求めた時点で自発的に起動する
---

## タンパク質を1体追加する

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