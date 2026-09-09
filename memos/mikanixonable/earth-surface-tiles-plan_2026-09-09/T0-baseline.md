# T0: 基準状態を保存する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

Earth実装を始める前のHEAD、検証結果、実行環境を固定する。proteinや雲などの無関係な差分をEarth作業へ混ぜない。

## 手順

1. 作業ツリーがcleanであることを確認し、HEADのfull/short commitを記録する。
2. Node/npm、OS、利用可能なブラウザを記録する。
3. ブラウザを起動してWebGPUやdrawing bufferを検査できない場合は、失敗ではなくunavailableと記録する。
4. 次のコマンドを順番に実行する。test:renderとtest:gameは同じtests/distを再生成するため並列実行しない。

   npm run typecheck
   npm run test:render
   npm run test:game
   npm run earth-surface:test
   python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'

5. 各コマンドの終了コード、成功件数、未実施理由を
   .earth-surface/verification/baseline.jsonへ保存する。
6. .earth-surface/raw、intermediate、bundle、distribution、撮影画像はGit管理対象へ入れない。
   verification/baseline.jsonだけを記録対象にする。

## 完了条件

- baseline.jsonにcommit、作業ツリー、環境、全コマンドの終了コードがある。
- 実ブラウザ、WebGPU、drawing bufferを使えなかった項目はunavailableと明記されている。
- baseline取得後の差分がEarth作業として説明できる。

## 取得済み記録

2026-09-10、commit 1eb94218を基準に取得した。
typecheck、render 85/85、game 200/200、earth-surface contract、Python 15件は成功。
WebGPUとdrawing bufferはブラウザセッションを起動していないためunavailable。
