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

## 降级方案

- ProseMirror / contenteditable DOM 写入；
- UEditor iframe body 写入；
- 最后复制到剪贴板提示手动粘贴。
