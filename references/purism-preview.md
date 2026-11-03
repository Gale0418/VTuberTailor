# PurismCore 本機靜態預覽（隔離入口）

`scripts/purism-preview/server.mjs` 是獨立的本機預覽 wrapper，不是 PuppetLoom 引擎、Live2D Core 或 VTube Studio runtime。它不包含任何 viewer binary；使用者必須自行提供已核對的 PurismCore Web v1.1.0 runtime 目錄。

## 佈署契約

`--runtime-root` 目錄必須包含下列四個已核驗檔案：

```text
purism-viewer.html
viewer.js
viewer.wasm
LICENSE-PurismCore-MIT
```

wrapper 在開啟 HTTP endpoint 前會用程式內固定的、已實際核驗之 PurismCore Web v1.1.0 四個 SHA-256 allowlist，比對 runtime bytes；不要求使用者另手寫 manifest，避免自簽 metadata 被誤當作信任。另驗證檔名、MIT 授權文字、檔案大小與 symlink realpath containment；不接受任意 HTML/JS/WASM 目錄。server 只綁 `127.0.0.1`，預設使用 port `0`，只服務 wrapper allowlist 與上述三個 runtime asset，不服務 runtime 其他檔案，也不接受 query model、remote URL、ZIP 或 archive。

```sh
node scripts/purism-preview/server.mjs \
  --runtime-root /使用者明確提供的/PurismCore-Web-v1.1.0 \
  --port 0
```

輸出是 JSON 的 ephemeral localhost URL。關閉時只回收該命令建立的 server；不會啟動、修改或連接 VTube Studio，也不會修改既有 Anime2.5DRig 頁面。

## 選擇性連接 Anime2.5DRig

`editor-integration.mjs` 可以從使用者明確指定的可信 Anime2.5DRig 程式目錄建立本機暫存快照，保留其 OBS relay，並加入開啟獨立 Purism sidecar 的連結。原始程式目錄不會被修改；它不是將 Purism 變成完整 Cubism 編輯器。

```sh
node scripts/purism-preview/editor-integration.mjs \
  --editor-root <可信的-Anime2.5DRig-目錄> \
  --runtime-root <已核驗的-PurismCore-Web-v1.1.0-目錄> \
  --port 8765
```

預設 host 是 `127.0.0.1:8765`；若該埠已被占用，程式會失敗，不會接管或停止既有服務。使用與原頁完全相同的 scheme、host 與 port 才會沿用該 origin 既有的瀏覽器儲存資料；sidecar 使用另一個動態本機埠。此入口依賴提供的 `obs_server.py` 在成功 bind 後輸出預期啟動訊息，因此 editor 來源必須可信。

預設不複製 PSD，原頁樣本 A/B、預設 OBS 範例與程式內 README 可能因此無法使用。若明確指定 `--sample-root <目錄>`，程式會複製該目錄的 `sample.psd`、`sample2.psd` 與 `README.md` 至本機暫存並供 loopback 存取；它不判斷內容是否私人。正常關閉時會清理本次建立且仍屬本程序的快照；無法確認程序停止或快照歸屬時會保留並回報。這個整合目前僅完成合成測試，尚未完成原 8765 頁面與角色的端到端驗收。

## 本機選檔邊界

`directory-preview.html` 優先使用 `webkitdirectory` 保留模型根目錄的相對路徑；瀏覽器無法提供相對路徑時，可分批用 multiple-file fallback 累積檔案，再按載入。fallback 只能取得每個檔案的 basename，不能證明使用者選取檔案原本位於 model3 參照的資料夾；因此它以 exact basename 映射，遇到重名、大小寫不符、歧義或缺漏就拒絕，不能把映射結果當成原始目錄結構證據。policy 只讀 model3 JSON 的 `FileReferences`，要求有效的非空 `Moc` 與 `Textures`，並對全部輸入檔案套用 traversal、absolute path、NUL、ZIP、數量與總大小限制。材質／MOC bytes 只有在所有 policy 通過後，才寫入 iframe viewer 的暫時 MEMFS；不寫 canonical 素材。

選取新模型時，wrapper 逐檔寫入暫存區，完整寫入後才替換舊模型；讀寫、替換或同步送出載入請求失敗時會嘗試還原。若還原失敗，畫面會回報保留的 backup 路徑。替換期間新舊模型會短暫同時佔用記憶體；iframe 重建會建立空的 MEMFS，而載入請求交給 viewer 後的非同步解析或渲染失敗不在這項回復保證內。

server CSP、固定 hash allowlist、runtime allowlist、realpath containment、開啟後以 immutable bytes snapshot 回應，以及在 iframe 的 `contentWindow.fetch` 上加同源 guard、移除 iframe canvas 的 upstream drop listener，是分層防線；fetch guard 不是父頁的 monkeypatch，也不能取代 server 驗證。直接開啟上游 viewer 或把不可信 runtime 放入 `--runtime-root`，不在此工具的安全保證內。固定 hash 只保護目前已核驗的四個檔案版本；若 upstream 更新，必須重新人工核驗並更新程式 allowlist 與測試。

viewer iframe 為了讓 wrapper 存取其 MEMFS 而同時允許 script 與 same-origin，因此不構成獨立的跨來源安全沙箱。此設計依賴固定雜湊核對過的 viewer 及可信的本機 wrapper；不可用來執行任意不可信 viewer。

## 能力與證據界線

此入口只主張 model3/moc3 的本機靜態載入與畫面請求。已驗證的 Purism viewer 文件指出它不是完整 viewer，缺少 physics 與完整 JSON parser；因此 `physics3.json`、`motion3.json`、webcam/tracking、Live2D Core／atlas 與 VTube Studio 都必須標示為未支援或未驗證。synthetic browser smoke 也不能代替角色視覺驗收、Core/atlas 讀回或 VTS 實機證據。

Chrome 合成模型測試已經由 multiple-file fallback 載入，並在宿主頁重整後再次載入；測試工具未能讓目錄選取產生有效的檔案清單，因此 `webkitdirectory` 模式尚未完成實機驗證。這項測試也未涵蓋獨立 iframe 重載、真實角色或原 Anime2.5DRig 頁面的端到端整合。

公開 repo 不應放入 Hiyori、r70、任何私人角色的 model3/moc3/texture/PSD、VTS preset、browser profile、ZIP、runtime cache 或 Live2D/VTS SDK binary。Purism MIT attribution 與授權檔必須和可散布 runtime 一起保留；它與 `vendor/puppetloom` 的 AGPL-3.0-or-later 分開列示。
