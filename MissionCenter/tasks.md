# 任務

`tasks.md` 是本輪唯一任務狀態來源。狀態只記錄已觀察事實；不可把尚未發生的 review、測試、commit 或 push 標成完成。

| ID | Title | Type | Parent | Priority | Status | Owner | Depends on | Next action | Verification | Estimate | Labels | Comments |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| MC-001 | 完成 CodeRabbit 真問題修正並發布 main | Epic | — | P1 | In Progress | Codex | — | 核實全部 findings、完成修正與驗證後發布 | 最終 diff、適用本機檢查、review 結果、README 與任務中心已更新、commit/push main 證據及收尾 Git 狀態 | — | execution,verification,closeout | 使用者已授權 CodeRabbit 上傳；每小時最多 3 次、每次最多 150 檔，本輪目標一次完整 scoped review + 必要時一次 focused re-review；不另開分支、不保留分支。 |
| MC-002 | 界定並完成一次完整 scoped CodeRabbit review | Task | MC-001 | P1 | Done | Codex | — | 以官方 v0.5.2 digest 演算法建立 passport，經 Rust transition 驗證後完成狀態轉移 | review 完成且 9 項安全 disposition 已核實；Rust passport gate 通過 | — | execution,verification | Review-1 完成；安全處置表在 references/code-review-2026-10-26.md。官方匹配版本算法、digest 與 transition 結果見 decisions.md、smoke-tests.md。Done gate 僅涵蓋 review 完成與 findings disposition，不代表 MC-003 實作／整合驗收。 |
| MC-003 | 驗證 finding 並修正真問題，必要時 focused re-review | Task | MC-001 | P1 | Done | Codex | MC-002 | 依最終驗證摘要建立 passport，經 Rust transition 完成正式狀態轉移 | 兩輪共 11 issues 有 disposition；受影響回歸、workspace build、smoke、真 Core export-move 與 VTS 引用驗證通過 | — | execution,verification | 最終證據見 [Review 摘要](../references/code-review-2026-10-26.md)：兩輪共 11 issues、10 fixed／1 rejected；Node 20/20、Python 10 pass/1 skip、vendor 9 files/53 pass、6 workspace build、19-layer smoke 10 PNG、搬移後官方 Core 77 poses／14 frames／0 failures／最大誤差 0.49328 px、VTS runtime references valid；final doctor ready=true。completion-check.md 為 critic_lite advisory，不是測試。 |
| MC-004 | 更新 README 與任務中心並提交上傳 main | Task | MC-001 | P1 | Review | Codex | MC-003 | 等 root 提供實際 commit SHA、push 結果與遠端 main 證據 | README／任務中心 diff 已準備；發布需實際 commit/push 證據與最終 Git 狀態，不留分支 | — | closeout | README 文件查證已完成。[README](../README.md) 展示使用者指定的三圖：透明原圖、大頭照、完成品；不含完整模型或 VTS 設定。文案描述實際補繪／綁定／驗收，不宣稱完全無人工的一鍵完成。待發布回報。 |
