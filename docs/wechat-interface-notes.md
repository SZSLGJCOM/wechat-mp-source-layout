# 微信公众号编辑接口调研记录

## 两类接口不要混淆

1. 公众号开放平台服务端 API：access_token、素材上传、草稿、发布等，适合服务器侧创建草稿或发布流程。
2. 微信公众号后台编辑页内部 JSAPI：`window.__MP_Editor_JSAPI__`，适合当前扩展这种“在编辑器页面内读取/写回正文 HTML”的场景。

## 当前采用的内部 JSAPI

- `mp_editor_get_content`：读取当前正文 HTML。
- `mp_editor_set_content`：写回全文 HTML。
- `mp_editor_get_isready`：探测编辑器是否 ready。
- `mp_editor_set_selection`：把临时上传载体放在原图之后，原图本身始终作为最终事务的唯一写回目标。

这些接口需要在微信公众号编辑页自身 JS 上下文中调用，公众号源码排版助手的 Chrome content script 需要注入 page-bridge 进入页面上下文。

## 图片交互约束

- 正文可能位于 UEditor iframe；图片坐标必须换算到顶层窗口，滚动监听也要同时绑定编辑文档和 iframe window。
- `mp_editor_set_content` 会重建正文节点。图片手势不能长期持有旧 DOM 引用，回写完成后要按图片身份重新定位，并重放尚未提交的本地状态。
- 图片选择、拖动与缩放由微信编辑器原生能力负责，扩展不创建竞争性的选中框或尺寸手柄。
- 像素效果只在本地离屏 SVG/Canvas 中烘焙为 PNG；SVG filter、`blob:` 和 `data:` 地址不得写入最终正文。
- 烘焙结果构造成 `File`，通过当前正文编辑器的 `paste` 监听器交给微信处理。扩展不得调用 `/cgi-bin/filetransfer`，也不得自行构造 ticket、scene 或素材身份。
- 合成 `paste` 的 `isTrusted` 为 `false`，浏览器不会执行默认粘贴。它不是微信公开 JSAPI，只在当前编辑器确实接收文件时可用；必须做能力检测并失败关闭。
- 粘贴前记录正文基线和文章身份；正常链路只接受原图之后的 `after` 上传载体。微信若原位替换原图，则恢复基线并失败关闭，不把替换节点升格为新的正文图片。
- 文件交给微信后，在编辑器生成可归属占位前短暂保护当前选区和正文输入；相邻占位一出现，立即写入本事务标记、隐藏临时载体并解除保护。
- 只有临时载体获得微信 CDN 地址且 `mp_editor_get_content` 能读到同一地址，才复制微信生成的原生图片属性，并把载体所有权交给统一图片快照。
- 最终正文只执行一次串行 CAS 提交：同一事务删除临时载体、把 CDN 来源写到原图，并合并尺寸、裁剪、样式和效果参数。提交后按稳定图片身份自动重绑，连续调节不要求重新选图。
- 粘贴未被接收、上传超时、正文模型未确认或文章已切换时，保留原图并停止提交，禁止回退到私有上传接口。
- 用户发起的 HTML 保存和图片提交共享修订号并使旧粘贴失效；维护型清理只进入同一串行队列，不得递增修订号或中断下一次上传。
- 撤回失败时，已归属候选的身份、文章身份、原图属性和位置语义移交给页面桥接清理队列；未归属的迟到图片不得按位置或 URL 猜测删除。
- 图片写回由一个串行事务协调；烘焙期间的普通样式修改合并到同一次正文提交，不存在并行的“样式提交”和“上传提交”。
- 正文只写入微信 CDN 地址；`blob:` 和 `data:` 地址不能作为可保存的最终图片来源。

官方与平台规范：[微信公众号编辑器 JSAPI](https://developers.weixin.qq.com/doc/service/guide/product/mp_editor_jsapi.html)、[微信公众号编辑器插件开发规范](https://developers.weixin.qq.com/doc/service/guide/product/plugin_spec.html)、[Clipboard API and events](https://www.w3.org/TR/clipboard-apis/)、[Chrome Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。

## 失败策略

- 新编辑器使用 `mp_editor_set_selection({ container, selectAfter: true })` 在原图后生成临时上传载体；旧 UEditor 降级为折叠在原图后的 DOM Range。上传载体不得升格为最终正文图片。
- 不使用 `navigator.clipboard.write`，避免权限、用户激活要求和覆盖系统剪贴板。
- 不使用 `document.execCommand('paste')`，避免引入 `clipboardRead` 权限。
- 不通过 `mp_editor_insert_html` 写入 data/blob 图片；公开文档没有承诺它会把这类地址转成微信素材。
- 编辑器不接收合成图片粘贴时，向用户报告失败并保留原图。
