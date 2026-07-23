# 微信公众号编辑接口调研记录

## 两类接口不要混淆

1. 公众号开放平台服务端 API：access_token、素材上传、草稿、发布等，适合服务器侧创建草稿或发布流程。
2. 微信公众号后台编辑页内部 JSAPI：`window.__MP_Editor_JSAPI__`，适合当前扩展这种“在编辑器页面内读取/写回正文 HTML”的场景。

## 当前采用的内部 JSAPI

- `mp_editor_get_content`：读取当前正文 HTML。
- `mp_editor_set_content`：写回全文 HTML。
- `mp_editor_get_isready`：探测编辑器是否 ready。
- `mp_editor_insert_html`：插入 HTML，作为 set_content 失败时的备用路径。

这些接口需要在微信公众号编辑页自身 JS 上下文中调用，公众号源码排版助手的 Chrome content script 需要注入 page-bridge 进入页面上下文。

## 图片交互约束

- 正文可能位于 UEditor iframe；图片坐标必须换算到顶层窗口，滚动监听也要同时绑定编辑文档和 iframe window。
- `mp_editor_set_content` 会重建正文节点。图片手势不能长期持有旧 DOM 引用，回写完成后要按图片身份重新定位，并重放尚未提交的本地状态。
- 图片选择、拖动与缩放由微信编辑器原生能力负责，扩展不创建竞争性的选中框或尺寸手柄。
- 高级图片效果在本地完成像素烘焙，随后使用编辑器本地文件场景 `scene=8` 上传；不得复用封面或素材库场景 `scene=1`。
- 本地上传先使用当前编辑页 token，仅在微信拒绝时刷新 ticket 后重试，避免把素材库授权作为前置依赖。
- 正文只写入微信 CDN 地址；`blob:` 和 `data:` 地址不能作为可保存的最终图片来源。

相关规范：[Pointer Events](https://www.w3.org/TR/pointerevents/)、[HTML Drag and Drop](https://html.spec.whatwg.org/multipage/dnd.html)、[Chrome Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。

## 降级方案

- ProseMirror / contenteditable DOM 写入；
- UEditor iframe body 写入；
- 最后复制到剪贴板提示手动粘贴。
