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


## 2026-10-28｜CDI3 合成回歸｜MC-008

- 如何測試：在 vendor/puppetloom 使用 macOS Node 24、獨立的相容原生依賴與短產物路徑，執行 `vitest run --config vitest.config.ts packages/core/test/cubism.test.ts`。
- 預期結果：CDI3 共用眨眼 ID 唯一，正反排列均保留左右名稱；同檔測試通過。
- 實際觀察：1 個測試檔、9 項測試全部通過。
- 結果：Pass（合成資料與該測試檔；尚非新角色匯出或 VTS 實機驗收）。
- 日期：2026-10-28
- 任務 ID：MC-008
- 執行類型：automated


## 2026-10-28｜r32 macOS 官方 Core 基線｜MC-006

- 如何測試：以本機 VTube Studio 的 `Live2DCubismCore.bundle` 及 `probe-core-render-contract.ps1` 讀取既有 r32 MOC，套用 5 個頭部／身體姿態，比對既有 Core 原始座標。
- 預期結果：載入 MOC，讀回對應姿態且座標與既有基線一致。
- 實際觀察：Core 5.0.0、23 參數、31 drawable、5 poses；37,330 個座標最大差異 0，缺項 0。
- 結果：Pass（離線 Core 幾何；不是 VTS 攝影機或圖集視覺驗收）。
- 日期：2026-10-28
- 任務 ID：MC-006
- 執行類型：automated


## 2026-10-28｜r32 VTS 頭部參數觀察｜MC-006

- 如何測試：使用者在既有 VTS 載入本機測試角色 r32，開啟「頭部左右」與「身體左右」設定；觀察面板數值變動，並由使用者以相同攝影機對照 Hiyori。
- 預期結果：確認 FaceAngleX 輸入及對應輸出是否有變動。
- 實際觀察：頭部輸入約 -6.66 至 -2.71、輸出約 -20.45 至 -9.45；身體輸入與輸出也變化。使用者確認 Hiyori 能跟隨轉頭，並指出 r32 轉頭與衣物動態不足。
- 結果：Pass（僅面板顯示的追蹤映射有變動；不代表實際視覺表現合格）。
- 日期：2026-10-28
- 任務 ID：MC-006
- 執行類型：manual

## 2026-10-28｜跨平台證據驗證與匯出器回歸｜MC-008

- 如何測試：使用 macOS Node 24 與任務專用相容原生依賴，執行 `packages/core/test/verify.test.ts`，以及 `cubism-native.test.ts` 的根目錄與雜湊篩選案例；另執行 `scripts/tailor.ps1 smoke`。
- 預期結果：相對路徑跨平台可讀，外連、越界、缺檔與錯誤雜湊受檢查；匯出器能定位來源並拒絕不符雜湊；合成專案流程正常。
- 實際觀察：證據路徑測試 8/8、匯出器定位測試 2/2 通過；合成 smoke 產生 19 個圖層及 10 張 PNG。完成後從另一個工作目錄執行 CLI 實際匯出本機測試候選成功。
- 結果：Pass（限上述合成測試、smoke 與 CLI 匯出；證據清單本身未由不可變歷史錨定）。
- 日期：2026-10-28
- 任務 ID：MC-008
- 執行類型：automated

## 2026-10-28｜候選模型官方 Core 與 atlas 檢查｜MC-009

- 如何測試：將獨立候選輸出為 MOC 與 atlas，以本機官方 Core 讀回並與來源取樣比較，產生姿勢畫面。
- 預期結果：模型可載入，姿勢數據在容許誤差內，貼圖畫面可供審查。
- 實際觀察：兩個候選各載入 23 個參數與 31 個 drawable，分別檢查 82 組姿勢，產生 16 張 atlas 畫面；位置最大誤差 0.384424 px，失敗 0。先前存在的低 alpha 邊緣雜點仍可見。
- 結果：Pass（離線 Core／atlas 數值檢查；視覺瑕疵與 VTS 實機驗收仍待處理）。
- 日期：2026-10-28
- 任務 ID：MC-009
- 執行類型：automated

## 2026-10-28｜頸領混合姿勢 Core／atlas 補充檢查｜MC-009

- 如何測試：對獨立候選 MOC 使用本機官方 Core 讀取中性、身體左右與頭身混合共 9 組姿勢，再以同一輸出 atlas 產生離線畫面。
- 預期結果：頸部與衣領隨身體參數變化，混合姿勢不出現可見透底裂縫。
- 實際觀察：每組讀取 31 個 drawable；身體左右 0.4 時，下頸頂點最大位移約 11.307／10.980 來源像素，上衣最大位移約 20.576 來源像素。所檢視的局部畫面未見明顯透明裂縫。
- 結果：Pass（限指定姿勢離線 Core 幾何與 atlas 畫面；VTS 即時動態仍待驗證）。
- 日期：2026-10-28
- 任務 ID：MC-009
- 執行類型：automated

## 2026-10-28｜多模型比較與頭身連動候選｜MC-009

- 如何測試：逐一檢查 VTS 內建及其他本機模型的設定、圖層與官方 Core 中性／角度端點；對獨立候選重新匯出、執行官方 Core 和 atlas 檢查，另核對身體左右及頭身混合姿態。
- 預期結果：候選的可見圖層能共同響應身體參數，中性外觀不變，混合姿態無明顯斷裂。
- 實際觀察：受檢參考模型 9 個；候選中性預覽 before/proposal 雜湊相同；Core 讀取 82 姿態、31 drawable、位置最大誤差 0.412325 來源像素，失敗 0。指定身體左右姿態中，舊版 10/31 drawable 位移、候選 31/31；離線混合姿態圖未見明顯接縫。
- 結果：Pass（模型與離線 Core／atlas；參考模型混色與 VTS 實機、物理時間序列仍需各自驗證）。
- 日期：2026-10-28
- 任務 ID：MC-009
- 執行類型：automated

## 2026-10-28｜綠底透明接縫 QA helper｜MC-009

- 如何測試：使用合成 RGBA fixture 執行 `tests/native-tools.test.mjs`，另以既有 16 張已驗證 atlas frames 產生三種底色 contact sheet，並執行 `smoke`。
- 預期結果：透明孔顯示指定背景、實色像素保持、來源 PNG 不變；原白底與深色底輸出一致，綠底能顯示透底。
- 實際觀察：9/9 tests 通過；原白底／深色底檔案 SHA-256 與抽出 helper 前一致，綠底新檔存在；smoke 通過，19 layers／10 PNG。82 poses 與數值 threshold 未變。
- 結果：Pass（通用 helper 與合成流程；不代表最終角色視覺或 VTS 驗收）。
- 日期：2026-10-28
- 任務 ID：MC-009
- 執行類型：automated

## 2026-10-28｜轉頭與眨眼交叉 QA、r48 分層驗收｜MC-007、MC-009、MC-010

- 如何測試：通用 QA 加入 yaw 兩端與雙閉眼／左右單閉眼交叉姿態，保留原 16 個視覺姿態；合成 fixture 驗證非標準範圍、mapping gating、三色背景與來源 PNG 不變。以同一 r48 執行來源驗證、官方 Core／atlas、VTS 固定輸入、錄製相機重播、無注入取樣及實機目視。
- 實際觀察：native-tools 11/11，synthetic smoke 19 layers／10 PNG；獨立唯讀程式複審未見 P0/P1。來源驗證 valid，Core 88 poses／22 renders／0 failures，最大位置誤差 0.459539 來源像素；29/29 VTS 受控姿態、8/8 重播通過。6 組實機畫面確認全身衣物位置連動與正面軀幹；無注入待機 36 筆有左右轉頭與完整雙眼閉合，FaceFound 均 false。
- 結果：上述控制、重播、離線及無臉待機檢查 Pass with limits；獨立 Core 目視 P0=0、P1=0、P2=1，仍有微小透點與髮邊雜色。正式 r48 相機另取 43 筆均 FaceFound=false，正向 live-camera 尚未驗收，不能由前版 46/46 有臉樣本替代；不宣稱整體完工。
- 還原：NDI 與相機設定已還原；OBS 音效按使用者核准保持關閉，測試熱鍵已移除且從未觸發，控制注入停止、取景還原。模型與詳細證據存於私人目錄，未納入公開 Git。
- 日期：2026-10-28
- 任務 ID：MC-007、MC-009、MC-010
- 執行類型：automated、manual visual

## 2026-10-30｜compact native mapping／r69 fresh readback 回歸｜MC-010

- 如何測試：執行 `tests/native-tools.test.mjs` 的 formal compact verifier；以 r69 舊的 9 姿態輸入重播官方 Core fresh readback，逐姿態核對 43 drawables；另保留 synthetic `smoke` 的 create／verify／render 結果。
- 實際觀察：formal verifier 21/21 通過；r69 9×43 readback 0 failures，最大位置差約 0.000179、UV 約 6.86e−8；synthetic smoke 產生 19 個圖層／10 張 PNG。
- 結果：Pass with limits。synthetic smoke 沒有覆蓋真正 Core verifier；Core／atlas 幾何回讀也不等於材質視覺通過。r69 的 VTS 載入、實機畫面與真人追蹤驗收仍未完成。
- 日期：2026-10-30
- 任務 ID：MC-010
- 執行類型：automated、official Core readback

## 2026-10-30｜網格索引寫入保護回歸｜MC-007

- 合成 mesh guard 測試 4/4，calibration overrides 測試 18/18，core typecheck／build 通過；逐 binding 檢查、歷史 restore 與現有 generated split 均有覆蓋。
- 首次 smoke 的 create 因 CLI 建置過期中止；重新 build CLI 後，合成 smoke 成功建立並驗證 19 層、渲染 10 張 PNG，報告為 `/private/tmp/vtt-meshguard-smoke-20261030-retry/smoke-report.json`。
- 結果僅限工具流程與合成資料。完整 model snapshot 中更動過的 keyform 未證明重映射正確；角色外觀、Core／atlas 和 VTS 真人追蹤均未由此驗收。
- 後續加上 binding 改名／metadata 和 JSON 鍵排序的防護後，使用短測試產物根重跑 mesh guard 4/4、generated split/clone focused 5/5、core typecheck 與重新建置 CLI 後 smoke 19 layers／10 PNG 通過；最新 smoke 報告 `/private/tmp/vtt-meshguard-rename-smoke-20261030/smoke-report.json`。保守比較可能誤拒合法常數變形，仍不構成 remap correctness proof。
- 為保留合法完整 model snapshot，後續已移除上述跨 keyform 拒絕策略；最新只阻擋未提供 snapshot 的危險寫入。最新 focused 測試 3 passed／1 skipped，typecheck、CLI build 及 synthetic smoke（19 layers／10 PNG）通過；報告 `/private/tmp/vtt-meshguard-compatible-smoke-20261030/smoke-report.json`。完整 snapshot 仍可能攜帶錯誤索引，沒有驗證 remap。
