# 公众号源码排版助手

适用于微信公众号图文编辑页的 Chrome 扩展，提供 HTML 源码编辑、真实手机阅读预览、图片处理和多图 SVG 动效生成。

## 功能

- HTML 源码模式：保留输入原文，支持重新载入、格式化、复制、保存、保存并退出；切换文章或关闭未保存内容时会先确认。
- 手机预览：在微信工具栏开启可拖动的 iPhone 阅读预览，编辑内容实时同步。
- 图片参数工具：点击文章图片即可调节圆角、尺寸、间距、阴影、发光、羽化、描边、色彩、透明度、相框、图注、圆形等；图片选中、拖动与缩放由微信编辑器原生处理。
- 像素效果：描边、色彩、阴影、发光与羽化按照图片 Alpha 轮廓烘焙为 PNG，再通过正文编辑器原生粘贴链交给微信上传；确认微信来源后撤回粘贴占位，最后与全部样式一次写回。
- SVG 动效工具：支持选择 2 到 9 张图片生成淡入、擦除、滑入、轮播、叠入等 SVG 动效。
- SVG 成品管理：已生成的 SVG 动效块可继续调整、删除或还原为静态图。

## 版本与更新

当前版本：`v0.11`

[查看更新日志](CHANGELOG.md) · [GitHub Releases](https://github.com/SZSLGJCOM/wechat-mp-source-layout/releases)

## 安装

1. 在 [GitHub Releases](https://github.com/SZSLGJCOM/wechat-mp-source-layout/releases) 下载“公众号源码排版助手”安装包并解压。
2. 打开 `chrome://extensions/`。
3. 开启开发者模式后，选择“加载已解压的扩展程序”。
4. 选择解压后的 `gongzhonghao-yuanma-paiban-zhushou` 文件夹。
5. 刷新微信公众号图文编辑页。
