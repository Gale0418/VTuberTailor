# VTuberTailor 修改紀錄

Copyright (c) 2026 CheshireMew（PuppetLoom 原始碼）。VTuberTailor 保留 AGPL-3.0-or-later 授權及原始 notices。

本 snapshot 基於 d12c3fc6233a35285a53478ef6dff6941cdd3c10，於 2026-10-26 帶入本機已驗證修改：素材 frame 配準／reference 量化、透明圖集邊緣 RGB dilation 與 padding、頭部／共享變形、網格與遮擋安全、revision 貼圖驗證、隱藏圖層評估效能、Core 透明度及層序匯出。

原 upstream Skill manifest 改名為 UPSTREAM-SKILL.md，避免被當成另一個自動 Skill；對應原始文字與 helper 均保留。原角色、workspace、node_modules、建置快取及 Live2D SDK binary 不包含在公開原始碼 snapshot 中。

本機原始修改狀態：
```text
 M docs/AGENT_USAGE.md
 M packages/core/src/asset-registration.ts
 M packages/core/src/asset-workflow.ts
 M packages/core/src/cubism-atlas.ts
 M packages/core/src/pose-field.ts
 M packages/core/src/render-contract.ts
 M packages/core/src/safety.ts
 M packages/core/src/schema.ts
 M packages/core/src/types.ts
 M packages/core/src/verify.ts
 M packages/core/test/asset-registration.test.ts
 M packages/core/test/asset-workflow.test.ts
 M packages/core/test/cubism-atlas.test.ts
 M packages/core/test/mesh-safety.test.ts
 M packages/core/test/pose-field.test.ts
 M packages/core/test/pose-occlusion.test.ts
 M packages/renderer/src/index.ts
 M packages/renderer/src/renderer.ts
 M scripts/lib/render-performance.mjs
 M tools/cubism-exporter/Main.kt
?? .tmp-patch-eye.cjs
?? packages/renderer/src/deformation-sharing.ts
?? packages/renderer/test/deformation-sharing.test.ts
```

VTuberTailor 額外可攜性修正：exporter bootstrap 預設使用專案內 cache 與 JAVA_HOME／PATH，移除原作者電腦的 D 槽 Java、Gradle、PSD2Live 工具目錄探測。CLI --java/--cache/--libs/--compiler 仍可明確指定。

預覽效能與錄影證據的獨立 profile 改用包裝器指定的專案 runtime 目錄，未指定時使用系統 temp，移除固定 D 槽 profile 依賴；不調整任何效能／幾何／安全門檻。Windows artifact root 由wrapper依原路徑預算選短路徑。

效能工具會保存既有 motion sampling 擷取的三張 canvas PNG 與 SHA-256，方便檢查實際預覽的圖層；寫檔發生於正式幀率測量與暖機之前，不變更測量門檻。畫面是引擎預覽，不是 VTube Studio。

CLI 工作區 helper 讀取子程序 stdout/stderr 時使用 UTF-8 stream decoder，並等 `close` 確認輸出排空後才解析 JSON；無效輸出的診斷摘要有長度上限並遮蔽常見憑證欄位。以 mock child process 測試 exit/close 時序、跨 chunk 中文和非零退出碼，不涉及 GUI 或門檻變更。
