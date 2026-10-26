# VTuberTailor｜原畫到 V 皮

保留角色神韻，把原圖與透明素材整理成可追溯的 2D VTuber 模型：拆件、遮擋補繪、像素配準、綁定、疊圖驗收，以及 VTube Studio 交付。

本 repo 本身就是一個完整 Skill。`SKILL.md` 是入口；`references/` 收錄按需流程；`scripts/` 提供可重複執行的工具；`vendor/puppetloom/` 保存包含本次修正的引擎原始碼。執行時不需要另一份 PuppetLoom checkout。此為獨立專案，非 PuppetLoom 官方分支；來源及 AGPL-3.0-or-later 授權見 [NOTICE.md](NOTICE.md)。

## 本機準備（Windows）

需要 PowerShell 7.4+、Python 3.10+，以及引擎支援的 Node 24.22.1（24.x）或 >=26.12.1。MOC/CMO3 匯出另需要 Java 21+；官方 Core 驗證使用你已安裝的 VTube Studio／Cubism Core DLL。

```powershell
git clone https://github.com/Gale0418/VTuberTailor.git
cd VTuberTailor
./scripts/tailor.ps1 setup -NodePath <node.exe> -PythonPath <python.exe>
# 若要匯出 Cubism：
./scripts/tailor.ps1 setup -JavaPath <java.exe> -WithExporter
./scripts/tailor.ps1 doctor --require-exporter --json
./scripts/install_skill.ps1
```

首次 setup 把 Node/npm 複製進本專案的 `.runtime/`，以 lockfile 建立新的 workspace links、建置引擎，並建立 Python QA venv。原生 exporter 的依賴以鎖定 SHA-256 驗證，在本機 cache 取得，SDK binary 不放進 GitHub。`setup` 可重跑；變更 package lock 時才重裝 npm 依賴，使用 `-ForceInstall` 可明確重建。

npm 優先從指定 Node 的同目錄尋找，再查 PATH；自訂安裝可另傳 `-NpmCliPath <npm/bin/npm-cli.js>`。搬動 repo 後，重跑 `setup -WithExporter`，更新本機 exporter 的絕對 cache 路徑。

`install_skill.ps1` 在使用者的 Codex skills 目錄建立指向完整 repo 的 junction。不要只複製 `SKILL.md`：本 Skill 的 scripts 和 vendor 是必要資源。重新開啟或重新整理 Skill 後，以 `$vtuber-tailor` 使用。

可用 `-Destination <實際 skills 目錄/vtuber-tailor>` 指定其他 Skill 探索位置（例如新版 Codex 的使用者 `.agents/skills`），避免安裝多個同名副本。

## 工具入口

```powershell
./scripts/tailor.ps1 help
./scripts/tailor.ps1 engine capabilities --json
./scripts/tailor.ps1 smoke --output <新的測試資料夾>
./scripts/tailor.ps1 inspect <RGBA.png> --panels <檢查圖.png>
./scripts/tailor.ps1 compare <原圖.png> <成品.png> --out <新的疊圖目錄> --scale 1 --tx 0 --ty 0
./scripts/tailor.ps1 verify-native --project <模型目錄> --export <匯出目錄> --core <Live2DCubismCore.dll>
./scripts/tailor.ps1 package-vts --export <匯出目錄> --output <新套件目錄> --name <角色名> --preset <既有model.vtube.json>
```

傳給 `engine` 的專案／輸入／輸出請用絕對路徑，因引擎命令以 vendor 目錄為工作目錄。各工具的 `--help` 列出精確參數；`register` 是 `engine assets register` 的簡寫。

固定 frame 的疊圖用來揭露差異，不會自動把眼睛局部拉伸到「看起來符合」。透明像素任意 RGB 不當作可見缺陷；亮膚色也不應因色差門檻被挖成透明洞。生圖／Python 編修依當次使用者授權選擇，Skill 不攜帶其他角色過去的永久授權。

## 驗證與資料

- `doctor` 檢查實際 Node、Python、workspace links、建置身分及 exporter classpath。`--forbid-root <已退役目錄>` 會拒絕任何仍解析回該目錄的執行依賴。
- `smoke` 從隨附的合成 PSD 建立另一個專案、驗證並渲染，不修改使用者角色。
- `verify-native` 用官方 Core 真正讀回 MOC，並渲染輸出 atlas。這和 VTS 實機截圖是不同證據；未經 Editor 開啟另存的 CMO3 也會明確標示。
- `package-vts` 保留指定 preset 的追蹤與位置設定，僅更新新模型必要欄位。它不自動安裝、啟動 VTS 或改安全／攝影機設定。
- `engine performance` 會短暫顯示一般預覽視窗以量測實際幀率，並保存畫布截圖；這不是全螢幕電腦操作，也不是 VTS 實機測試。
- `projects/`、`.runtime/`、`local-reports/`、封存及角色原圖預設不進 git。角色資料留在使用者選定的專案目錄。

本機遷移／刪除舊工作區時，先依使用者指定的範圍保留並驗證必要原始碼、角色素材及成品，再把舊路徑移開進行冷啟動、建模、渲染及匯出測試，通過才刪除。完整歷史封存可使用 `archive_workspace.py`，未完成驗證的 ZIP 不可當作備份。詳細步驟見 [references/migration-and-vts.md](references/migration-and-vts.md)。

## 開發檢查

```powershell
./scripts/test.ps1
./scripts/test.ps1 -Engine
```

第三方引擎原有授權與 notices 保留在 `vendor/puppetloom`。snapshot 的 upstream commit、檔案來源及本機修改記錄見 `upstream.json`、`vendor/puppetloom-source-manifest.json`、`vendor/puppetloom/VTUBERTAILOR_CHANGES.md`。

本次完整流程的已執行項目與限制見 [references/validation.md](references/validation.md)。

引擎測試有 Windows 路徑長度預算；包裝腳本使用較短的 runtime 產物根目錄，必要時改用系統 temp。也可明確設定 `PUPPETLOOM_ARTIFACT_ROOT` 為較短路徑，不會放寬原有長度或安全門檻。
