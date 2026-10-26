# Smoke Tests

## 2026-10-26｜任務中心初始化與一致性｜MC-001

- 如何測試：正式 Rust CLI 執行 `doctor --root .`、`status --root .`、`verify --root .`。
- 預期結果：任務表可解析、無不明任務狀態；工作集與摘要不過期；檔案驗證成功。
- 實際觀察：`doctor` 回報 `status=pass`、`tasks=pass`、`writer_lock_recovery=pass`，並註明目前沒有 Done 任務需要 completion passport；`status` 回報 `status=ok`、`stale=false`、`sourceFresh=true`、4 tasks；`verify` 回報 `status=pass`、SHA-256 digest `80abea64d7994d3aebafde4d7b8974d94057354ee468e9fb5588beb01ea30716`。
- 結果：Pass（僅限 MissionCenter 工作區檢查；不代表程式測試、CodeRabbit review 或發布通過）。
- 日期：2026-10-26
- 任務 ID：MC-001
- 執行類型：automated

## 2026-10-26｜README 依賴版本與 CLI 範例查證｜MC-004

- 如何測試：比對 README Python 最低版本與目前鎖定 NumPy package METADATA；執行 README 中 `inspect --panels` 範例並確認 CLI 回報，再以補上 `--roi` 的範例重跑。
- 預期結果：README 最低 Python 版本符合鎖定依賴；panels 範例帶齊必要 ROI 輸入並成功產生 PNG。
- 實際觀察：NumPy METADATA 標示 `Requires-Python >=3.12`；README 原 `3.10` 已修正為 `3.12`。`inspect --panels` 缺 `--roi` 修正前 exit 1，補上 `--roi` 後 exit 0 並產生 PNG。
- 結果：Pass（限 README 本地查證；不是 CodeRabbit finding，也不代表整體程式測試或發布通過）。
- 證據：`local-reports/coderabbit-20261026/documentation-check.json`、`readme-corrected.json`。
- 日期：2026-10-26
- 任務 ID：MC-004
- 執行類型：manual

## 2026-10-26｜第一輪 CodeRabbit 審查完整性與 disposition 紀錄｜MC-002

- 如何測試：核對公開安全的逐項 review 表，確認總數、修正／反證 disposition，並核對其中記錄的 targeted 驗證摘要。
- 預期結果：review 狀態為 completed；9 項 findings 均有明確處置；每項處置有簡要查證或驗證依據。
- 實際觀察：[Review 摘要](../references/code-review-2026-10-26.md)記錄 150 個 reviewed files、9 issues（2 major、7 minor）、0 errors；8 項成立並修正，一項 issue 6 以路徑實值相同及兩種 equality 實測反證拒絕。針對性檢查結果亦列於同一摘要。
- 結果：Pass（僅驗證第一輪 review 完成與逐項處置紀錄；不是整合／smoke 測試、第二輪 review 或發布通過）。
- 日期：2026-10-26
- 任務 ID：MC-002
- 執行類型：manual
## 2026-10-26｜修正 finding 的 targeted regression 與 19-layer smoke｜MC-003

- 如何測試：root 執行受影響 Node／Python／image／vendor regression suites，以及 19-layer smoke workflow。
- 預期結果：受影響回歸檢查通過、預期輸出影像可生成；匯出目錄搬移後仍能由官方 Core 讀取，VTS runtime 引用有效。
- 實際觀察：最終 [Review 摘要](../references/code-review-2026-10-26.md)記錄 Node 20/20、Python 10 passed/1 skipped（junction pass）、vendor 9 files/53 tests、六個 workspace build、19-layer smoke 產生 10 PNG；實際搬移匯出目錄後官方 Core 讀取 77 poses、14 frames、0 failures、最大誤差 0.49328 px 以內，VTS runtime references valid；final doctor ready=true。
- 結果：Pass（限摘要列明的最終本機 checks 與合成 fixture Core/VTS 引用驗證；未啟動 VTS，不代表發布已完成）。
- 日期：2026-10-26
- 任務 ID：MC-003
- 執行類型：automated

## 2026-10-26｜官方 taskDigest 與 MC-002 passport gate｜MC-002

- 如何測試：按安裝版 Mission Center v0.5.2 對應 GitHub release tag source 的 `canonical_task_digest` 實作與 task parser canonical alias，從 `tasks.md` 的 MC-002 canonical 欄位計算 digest；以安全 findings summary 建 passport，再執行正式 Rust `transition MC-002 Done`。
- 預期結果：Rust transition 驗證 passport digest、evidence refs 與 9 項 disposition，成功將 MC-002 從 Review 轉為 Done。
- 實際觀察：官方 Rust CLI transition 回報 `from=Review`、`to=Done`、`written=true`、`status=committed`；gate 接受依官方算法產生的 digest 及 evidence refs。初次計算被 gate 拒絕後，依官方 task parser 確認目前表頭 `Labels`／`Comments` 不映射到 canonical `Tags`／`Notes`，按實際 parse 結果重算後通過；未保留被拒絕的 passport 狀態。
- 結果：Pass（只完成第一輪 CodeRabbit review 與 9 項 dispositions 的 MC-002 gate；不代表 MC-003 實作驗收或發布通過）。
- 日期：2026-10-26
- 任務 ID：MC-002
- 執行類型：automated

## 2026-10-26｜MC-003 passport transition 與工作區最終驗證｜MC-003

- 如何測試：使用官方 v0.5.2 digest／parser 契約建立 passport，依序執行正式 Rust transition；完成後執行 `sync`、`doctor`、`status`、`verify`。
- 預期結果：MC-003 passport 通過並由 Review 轉為 Done；任務來源同步、completion passport 檢查與檔案驗證成功。
- 實際觀察：Rust transition `In Progress→Review` 與 `Review→Done` 均為 `committed`；最後 `doctor=status pass`、`tasks=pass`、`completion_passport=pass`；`status=ok`、`sourceFresh=true`、`stale=false`，MC-002／003 為 Done、MC-004 為 Review；`verify=status pass`。
- 結果：Pass（僅限 MissionCenter passport 與工作區一致性；MC-004／Epic 仍等實際發布證據）。
- 日期：2026-10-26
- 任務 ID：MC-003
- 執行類型：automated

## 2026-10-26｜README、授權展示圖片與 main 發布核對｜MC-004

- 如何測試：核對本機發布 commit、push 輸出、GitHub `refs/heads/main`、遠端 README 與 `assets/examples/` 三圖 metadata/blob SHA，並檢查最終本機 Git 狀態與分支。
- 預期結果：程式修正、README 與僅獲授權的三張展示圖片推送至 `main`；遠端內容與本機相符；工作樹乾淨且無額外分支。
- 實際觀察：commit `e6504fd8bf4d4457e8526543130bd5b56e1110f4`，push exit 0（`9b038c6..e6504fd main -> main`）；GitHub connector 獨立讀取遠端 main 同一 SHA，確認 README 新標題／三圖標籤與三個 PNG metadata；三圖 blob SHA 逐一與本機 Git 相同。執行後 Git status porcelain 為空、分支只有 `main`，且 `main` 與 `origin/main` 同步。root 記錄實際觀察時間為 2026-10-26T09:53:23Z（台北 17:53）。
- 結果：Pass（程式／README／限定展示圖已公開推送；這是第一次發布，不代表後續 MissionCenter receipt-only 更新已推送）。
- 證據：[發布 commit](https://github.com/Gale0418/VTuberTailor/commit/e6504fd8bf4d4457e8526543130bd5b56e1110f4)、README 與 `assets/examples/` 三圖。
- 日期：2026-10-26
- 任務 ID：MC-004
- 執行類型：manual

## 2026-10-26｜MC-004 與 MC-001 完成 passport transition｜MC-001

- 如何測試：依官方 v0.5.2 digest/parser 契約建立完成 passport，使用 Rust CLI 對 MC-004 執行 Review→Done，對 MC-001 執行 In Progress→Review→Done。
- 預期結果：passport 與發布證據通過；所有 Epic／Task 均為 Done，無未完成 blocker。
- 實際觀察：三個 Rust transition 均回報 `status=committed`、`written=true`；狀態最終為 MC-001～MC-004 全 Done。首次程式與 README／授權展示圖發布已由上方 MC-004 核對；最終 MissionCenter receipts 待 root 做 docs-only commit/push，這是發布後的收據同步。
- 結果：Pass（限 MissionCenter passport gate 與本輪既有發布證據；docs-only 收據同步尚未發生）。
- 日期：2026-10-26
- 任務 ID：MC-001
- 執行類型：automated
