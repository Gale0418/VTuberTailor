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

2026-10-26 CodeRabbit 查證修正：texture worker 首錯後停止領取工作，遲到 bitmap 僅關閉、不再建立 GPU 資源，所有活動 worker 結束後才傳出首錯；Photoshop helper 同樣等待 UTF-8 輸出排空後解析。runtime-control-service 的測試目錄改由既有 artifactPath 管理。這些修正不改動角色圖像、canonical revision 或幾何／效能門檻。

2026-10-28 CDI3 匯出修正：共用相同 Cubism ID 的參數只輸出一筆顯示資訊，優先保留較專屬的單目標名稱；全域與左右眨眼的模型映射不變，並以合成資料測試不同排列順序。

2026-10-28 驗證可攜性修正：讀取校準 session 的 evidenceDirectory 時正規化 Windows 相對分隔符，並持續拒絕絕對路徑、drive/UNC 路徑與目錄穿越；檔案存在與 SHA-256 證據驗證行為不變，使用合成 fixture 覆蓋跨平台與損壞案例。

2026-10-28 驗證邊界修正：專案根與 evidence/asset 路徑另以 realpath 檢查，拒絕專案內 symlink/junction 指向根外；不存在的檔案回溯最近存在父目錄，仍回報原有缺檔診斷。比較清單的既有 immutable hash 欄位範圍未擴張。

2026-10-28 Cubism native exporter root 修正：exporter 原始碼根不再只依賴 core `import.meta.url` 的固定相對層級；有設定時優先從 `PUPPETLOOM_NATIVE_EXPORT_CONFIG` 的路徑祖先尋找通用 exporter source，否則回退至 core 模組與目前工作目錄祖先，保留 source SHA-256 gate。合成測試覆蓋 bundled core 的 config-root 定位，並以 CLI build 確認入口相容，不涉及角色資料。

2026-10-29 neck anatomical attachment 修正：neck 的 head pose／roll attachment weight 改以 `vertexIndex` 對應的 neutral `layer.mesh.points` rest 座標計算，避免 parent XY authoring deformer 移動後改變解剖位置權重；缺少、越界或非整數 index 時維持既有 `base` fallback。新增合成 regression 覆蓋 parent XY translation 下 top roll 角度保持、bottom anchored 與 undefined-index 相容；不改 body/gaze 權重、模型素材或 Core 門檻。

2026-10-29 dynamic head surface 邊界連續性修正：新增僅供 runtime head-surface lookup 使用的有限 smooth transition，讓小幅 barycentric 外插平滑銜接最近邊界，並在相鄰三角形的 boundary-edge 選擇窄帶內連續混合；超過安全範圍仍沿用 edge clamp。remesh 與 influence reprojection 的既有 `sampleLocation` 語意不變。合成測試覆蓋舊版 extrapolation→clamp 跳變、閾值／最近邊界切換連續、極端點有限性與 model body-sway 交界；r56 neck 100% body-sway 在 0.5 px native bake 通過，未修改模型素材或 VTS 設定。

2026-10-29 generated layer triangle split API：新增 calibration 公開 helper，可將具 immutable `generatedAsset` provenance 的既有圖層按完整且互斥的 triangle ownership 複製成多個共用原 texture 圖層；points、UV、influences、動作 bindings 皆保留，原圖層自動隱藏，未知圖層、重複／遺漏／非法 triangle 與缺少 provenance 均 fail-closed。合成測試覆蓋 persistence/preview 一致、source provenance、visibility、binding 複製及錯誤輸入；不改像素、canonical 或 VTS。另確認既有 `saveAuthoringPatch` 不會持久化新增 layer，故 helper 產生既有 `assetLayers` calibration patch，沿用 revision guard 與 immutable record 路徑。

2026-10-29 triangle split 邊界修正：分割層以原始 `(order, array index)` stable draw order 將 source 原位替換，避免同 order 鄰層被錯誤插到 source 前後；target 未指定 `visible` 時繼承 source，只有明確指定才覆蓋。若 source 被 parent/clip、collision 或 production state 引用而無法安全一對多重映射，操作直接拒絕；新增合成回歸覆蓋 refined-shoulder 同 order、隱藏來源與引用阻斷。

2026-10-29 triangle split 正規入口修正：新增 `prepareLayerTriangleSplitPatch`，先由 effective `loadProject` 與目前 calibration revision 建立 patch，再交由 `saveCalibrationPatch` 的 CAS guard 保存；保留上游 `generatedAsset.templateLayerId` provenance，不要求等於 source layer。`semantic.role/side/visible` 改為明確語意覆寫（不宣稱像素恆等），含動態 `drawOrderOffset` 或未能安全重映射的來源引用時 fail-closed；補上 synthetic save/load roundtrip、existing assetLayers/model 保留與 stale revision 測試。

2026-10-29 calibration snapshot CAS 修正：triangle-split prepare 與 authoring save 均以同一份 base project/calibration snapshot 建立 patch；新入口攜帶 optional base-project SHA，commit lock 內比對後再執行 revision CAS，舊版未帶 SHA 的 CalibrationPatch 維持相容。新增 revision-0 更換 base project 的 fail-closed regression，避免空 calibration 的舊 hash 例外覆寫新 base。

2026-10-29 triangle split 驗收限制：此 helper 複製既有 generatedAsset 欄位，不獨立驗證一般密度素材的 registration、reference 或 PNG 雜湊；使用前仍須確認來源登記。跨目標圖層若有重疊三角形，分層繪製可能改變透明覆蓋，即使原圖層內的三角形順序保持一致，也不能保證所有姿態像素相同。須逐姿態比較可見材質，並另驗證 native Core／atlas 和 VTS；合成測試或離線預覽不等於實機驗收。

2026-10-30：修正自動產生的 Cubism physics3 兩粒子彈簧輸出為 Angle，讓 Scale 正確作用於輸出；X 輸入不變。VTS A/B 診斷確認原 X 輸出恆為零、Angle 輸出有變化，擺幅仍須依模型實測調校。

2026-10-30 generated layer clone API：新增公開 calibration clone helper 與 prepare 入口，驗證 immutable `generatedAsset` provenance 後，以同一 texture／provenance 建立新 layer ID；source layer 保持不變，副本預設繼承 pivot、deformer、layer weights 等非頂點索引 metadata，必要時可再用公開 calibration layer override 安全覆寫。每個副本可提供 schema-valid mesh、order 與語意覆寫；mesh points 沿用專案 schema 的 finite 座標規則，UV 仍須為 0..1，最終 project schema／safety 驗證負責整體範圍。自訂 mesh 預設不複製含 vertex index 的 layer bindings；只有未更換 mesh 且明確指定 `bindingMode: "copy"` 才複製。source 只要有 indexed `hairStrands`，即使 exact mesh 也因沒有全域 ID／頂點 remap 而 fail-closed；clone 不偽造 PSD 原生 `sourceLayerId`，並拒絕零面積 triangle。這些 metadata 繼承不代表 procedural/head 權重或實機視覺行為已驗收，仍須針對目標角色做姿態與 runtime 檢查。保存仍必須交給 `saveCalibrationPatch`，沿用 base-project SHA 與 revision CAS；合成測試覆蓋成功保存、來源保留、客製 mesh/order、重排 mesh 的安全拒絕、hairStrands／退化 triangle 邊界、失效 provenance 與 stale revision。未修改角色、PNG、canonical 或 VTS。

2026-10-30 portable export 邊界註記：portable export 對 generated-layer provenance 的既有缺口不在本次 clone API 範圍內；本次不擴大 export／封存重構，也不把 clone 的合成驗證宣稱為 portable 或實機交付驗收。

2026-10-30 Cubism atlas 去重：atlas packer 以解碼後 RGBA bytes、寬高和 SHA-256 分組，讓保留相同 immutable texture 的 generated layer 共用同一個 padded rectangle；每個 layer ID 仍各自保留 placement alias，mesh、UV、draw order、opacity、mask 和 source provenance 不變。不同尺寸或任何像素差異不合併，並以 hash 命中後逐 byte 比對防止碰撞誤合併。重複 layer ID 在解碼前 fail-closed，解碼改逐項進行以避免全量 raw buffer 同時駐留，alias ID 寫入 placement 前排序以維持 key 順序 deterministic。新增 synthetic coverage；未修改角色、PNG、canonical revision 或 VTS，未執行 native export。

2026-10-30 native export mesh compact：加入僅供 native export 的暫時 layer/project view，且只有明確 `topology: "art"` 才允許壓縮；legacy／undefined／grid 一律回退。依 triangles 收集 referenced vertices 並穩定 remap points、UV、triangles、所有已知 influence channels，以及 target-layer sparse meshPointDeltas；合法範圍內但完全 orphan 的 sparse delta 在 view 中省略，非法／越界 index 仍 fail-safe 回退。native sampler／deformer／poseField／poseOcclusion／opacity／draw order 仍在 compact view 上求值，canonical project 不變。含 hairStrands、moving collision 或未知 vertex-indexed 欄位時回退原始 mesh，不靜默丟掉可能影響輸出的資料。合成測試覆蓋 1069→71 vertices／110 triangles／998 orphan、head keyform surface、deformer、clip/order、neutral／yaw/pitch／blink 等價、input vertex/index consistency 與 fallback；未修改角色、PNG、canonical 或 VTS，未執行全模型 native export。

2026-10-30 calibration 網格索引保護：新的既有圖層網格 layout 寫入若仍有 indexed keyform 頂點資料、但 patch 沒提供完整 model snapshot，則拒絕保存，避免舊頂點編號仍在範圍卻指到不同位置。完整 model snapshot 維持既有手動重映射流程，歷史 revision 讀取與還原亦維持既有語意；此防護不驗證 snapshot 的 remap 是否正確，也不阻止 caller 原樣重送舊資料。合成測試涵蓋無 model snapshot 的危險寫入、無 indexed 資料、完整 snapshot、歷史還原及帶 indexed keyform 的既有 generated-layer split。

2026-11-02 offline render 低記憶體 opt-in：新增僅供明確選用的 visibility-aware texture loader，對可見圖層及直接 clip 目標逐一解碼，依既有 `join(root, layer.texture)` 再正規化的解析後 texture path 去重並讓共享材質共用同一 PixelBuffer；public `loadProjectTextureSources` 的全量／共享／錯誤語義不變。render-suite 以 `lowMemoryTextures: true` 啟用，維持相同 render pixels；合成測試覆蓋 shared material、hidden non-clip 跳過、hidden clip 使用、缺失可見材質錯誤、A/B exact pixels 與多姿態一致性。`compareProjectStates` 等既有呼叫仍使用預設 loader，未擴散 opt-in API。未修改角色、PNG、canonical revision 或 VTS。

2026-11-02 calibration evidence 低記憶體 opt-in：`saveCalibrationPatch`／`saveAuthoringPatch` 可透過第三個 optional `lowMemoryTextures: true` 將 visibility-aware sequential loader 傳入前後 suite 與 mesh-rebuild neutral comparison；`restoreCalibrationRevision` 亦可透過第五個參數 options 傳遞同一設定。未傳參數時維持既有全量 loader、revision CAS、證據輸出與錯誤語義。未使用環境變數全域切換，未修改角色、PNG、canonical revision 或 VTS。

2026-11-02 neutral evidence 低記憶體峰值修正：`compareNeutralProjectStates` 的 low-memory 分支改為先載入／渲染 before，再讓 before texture Map 離開作用域後載入／渲染 after；未假設 JavaScript 立即 GC。預設 full-loader 分支仍維持原本 before/after 並行載入，輸出像素與差異計算不變。

2026-11-02 Cubism native exporter 搜尋邊界修正：未設定 `PUPPETLOOM_NATIVE_EXPORT_CONFIG` 時只搜尋 core `moduleRoot` 祖先，不再從目前工作目錄隱式選取 exporter source/config；顯式 config 路徑祖先搜尋、source SHA-256 gate 與正常套件內 runtime 行為不變。新增合成回歸，確認 CWD 內偽造 exporter 不會被自動採用；未修改角色素材、canonical revision 或 VTS。

2026-11-02 offline render 逐層 opt-in：新增獨立逐圖層解碼及直接 clip mask 快取的姿態渲染入口；可見素材與直接遮罩順序處理，缺少直接遮罩時拒絕。不改既有 loader 或 render-suite 預設，尚未接入 suite；僅減少同時持有的 decoded texture 引用，不保證 GC／Sharp 原生記憶體峰值。極小合成素材在六種 blend mode、隱藏遮罩及缺失遮罩與既有 Map 路徑比較；未執行完整 Vitest、真角色、Core/atlas 或 VTS。
逐層入口可能多次讀取同一路徑；渲染期間須保持素材不變，否則不能保證同一路徑取得一致快照。與 Map 路徑的合成像素一致不等於 WebGL／Core／VTS 畫面一致。

2026-11-02 desktop preview semantic slider：`setPreviewField` 與九宮格 `setPreviewPose` 只更新實際 semantic 欄位並移除相符的 explicit parameter overrides，讓 core 保留 expression／behavior 合成；全域眨眼移除 global／左右 explicit entries，缺省 side fields 使用 core fallback，已有 side fields 才同步成全域值。九宮格仍保留原有 body/gaze 耦合比例；新增合成 invariant 覆蓋先改 parameter 後拖滑桿、active expression（含 stale override）、重複 semantic、repeat 參數、左右眨眼與無對應 semantic 邊界，並以 `resolveMotionState` 驗證 resolved state。未修改角色素材、canonical revision 或 VTS。

2026-11-02 render suite 逐層 opt-in：新增 streamingTextures 選項供逐姿態與 focus、neutral before/after 使用逐層 renderer；預設與 lowMemoryTextures 路徑維持原樣，兩種選項同時指定會在輸出或讀取前拒絕。合成 fixture 已比較 pose/focus PNG 並測異常輸入；不保證 Sharp／GC 的實際峰值，非真角色、Core／atlas 或 VTS 驗收。

2026-11-02 offline 局部視窗：逐層入口新增可選畫布正規化 viewport，局部與直接遮罩以同一座標映射並裁切至視窗，非方形 aspect-fit 留白維持透明；預設完整畫布保留既有行為，極小或無效比例在分配輸出前拒絕。PNG 入口共用輸出像素 backing store 避免額外 RGBA 複製。合成 ROI 與同尺寸全圖裁切及 PNG decode 比對；未驗證真角色、Core/atlas、VTS 或實際記憶體上限。

2026-11-02 緊急容量恢復說明：上一項 viewport / PNG backing-store 優化暫存於 local-reports/viewport-draft-20261102，尚未包含於目前 source 或 runtime；逐層 renderer 與 render suite streaming 選項維持。為恢復舊成功 CLI 建置，僅回退該次 viewport 差異，source 及 dist 雜湊均與既有 build identity 相符；空間恢復後需審視草稿及重新套用、建置與驗證。
