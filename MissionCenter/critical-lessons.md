# Critical Lessons

## 已驗證經驗 · 2026-10-28

- 官方 Core 幾何誤差通過，不代表可見接縫通過。中立、左右端點、雙眼／單眼閉合須交叉以實際 atlas 綠底放大檢查；保留中立幾何可能同時保留既有破洞。通用 QA 已新增相應交叉姿態與高解析畫面。
- 全圖 alpha 差分必須先證明構圖與座標對齊；只有相同比例與 canvas 長寬不夠。未對齊的 opaque→transparent 元件只能作 provisional 診斷，不能當修洞證據。
- VTS 1.35.10 的 NDI 設定實測中，省略的布林欄位會回到預設；A/B 還原須提供完整原設定 tuple，並用唯讀 API 逐欄核對，不能只依 setter 成功回覆。
- 設定檔的相機欄位值不能直接當成實際 capture FPS；應另記錄追蹤程序啟動參數、API 取樣窗口與限制。`StatisticsRequest.framerate` 則是 VTS render FPS，兩者需分開。
- VTS 重開後優先沿用私人本機快取的既有外掛憑證；保護檔案權限、不輸出 token、不加入 Git。應用程式必須完成啟動並確認 API 埠已監聽，再重連；不因連線失敗反覆要求新授權。
