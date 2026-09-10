# T6-2: 外部静的配信（廃止）

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 状態

2026-09-10に要件を廃止した。本番の地表データはGitHub Pagesの同一originだけから配信し、
外部origin、CORS、外部upload、remote-checkは受け入れ条件にも運用にも含めない。

## 取り扱い

旧実装は本番経路から削除する。必要なローカルfixtureの検査はT6-1のPages同一origin検査へ移す。
このファイルは判断履歴として残し、新しい実装や公開作業の入口にはしない。
