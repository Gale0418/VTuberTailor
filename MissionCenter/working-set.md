<!-- Generated materialized view. Do not edit directly; rebuild from canonical MissionCenter files. -->
<!-- mission-center-derived schema=1.0 fingerprint-format=sha256-v2-lf source-fingerprint=9ff546de26cd515e130a42382a71a3ae77f2206324b976dbbd1514468936eef2 -->
# 當前工作集

- 唯一真實來源: `tasks.md`
- 可執行項目數: 6

| ID | 標題 | 優先級 | 狀態 | 下一步 | 依賴 | 驗證方式 | 阻塞原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MC-005 | 修復本機測試角色 VTS 追蹤、動態與接縫 | P1 | In Progress | 依真人缺陷重建頭髮／臉部共用動作並重驗 | — | 對照 Hiyori、同姿態 Core／atlas 與 VTS 實測 |  |
| MC-007 | 修復頭身衣物動作與頸部接縫 | P1 | In Progress | 修正臉、五官與頭髮連動及頸部接縫，補齊三軸複合驗收 | MC-006 | 同姿態參數測試與 Core／atlas 視覺檢查 |  |
| MC-009 | 匯出候選並驗收 VTS 實機 | P1 | In Progress | 修正後重播真人複合姿態並檢查臉髮接縫 | MC-007, MC-008 | 引用、同姿態 Core／atlas、VTS 追蹤與外觀 |  |
| MC-010 | 對照官方模型、獨立複審與收尾 | P1 | In Progress | 依已允許的官方教學複審修正版真人複合姿態 | MC-009 | 審查與 smoke 紀錄、未完成事項 checkpoint |  |
| MC-011 | 擴充右側預覽器的可編輯姿態與模型資料 | P1 | In Progress | 修好 X/Y 四象限與臉髮連動後，檢查官方模型網頁預覽和 VTS 接軌 | — | 合成 invariant、角色同姿態視覺及適用的 Core／VTS 實測 |  |
| MC-006 | 保存原版並建立 Mac 驗證環境、定位追蹤根因 | P1 | Review | 複核已保存備份、Mac 環境與追蹤根因證據 | — | 備份一致性、引擎 capabilities、輸入與輸出證據 |  |
