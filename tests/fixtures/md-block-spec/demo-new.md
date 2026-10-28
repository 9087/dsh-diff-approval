---
title: 结构化预览综合样本（第二版）
version: 2
status: stable
tags:
  - alpha
  - gamma
owner: 吴志伟
note: |
  多行说明第一行
  多行说明第二行
---

# 第一章 概览（修订）

这是第二版的一段普通文字，包含链接 [项目文档 v2](https://example.com/new) 和行内代码 `npm run new`，后面还会继续写一些内容。

这一段会被合并的第一段，现在和第二段接在一起了。

新版本新增的一段话，用来验证新增段落的显示。

## 第二章 表格

| 场景 | 应返回 | 说明 |
| --- | --- | :---: |
| `None` | `false` | 不弹 |
| `All` | `false` | 弹窗确认 |
| `NewRow` | `true` | 只在新版本存在的行 |
紧跟在表格后面、表格后没有空行的第一行段落。
这是没有空行紧跟表格的第二行，新版本已经改写这一行，而且写得更长一些，用来验证表格吞掉段落时的标注。

## 第三章 列表

- 普通列表项
- 会被改写的列表项：新写法，内容更长一些
- 新增的列表项
- 嵌套列表：
  - 嵌套项一（已修改）
  - 嵌套项二
  - 新增的嵌套项
- [x] 未完成的任务
- [x] 已完成的任务

1. 第一步
2. 第二步（修改）
3. 第三步
4. 第四步（新增）

列表起始编号：

5. 起始编号项

列表 marker 样式：

* marker 样式项

## 第四章 引用

> 引用第二版文字，内容有改动。
>> 嵌套引用新文字。

> 新增的一段引用。

## 第五章 代码

```ts
const version = 2
console.log('new')
```

```bash
echo "added block"
```

语言的整块变化（json → yaml）：

```yaml
version: 2
status: stable
```

```js
console.log('added code block')
```

## 第六章 链接与图片

行内链接文字 [新链接文字](https://example.com/page)，以及只改 URL 的 [目标不变](https://example.com/v2) 链接。

参考式链接：[参考链接][ref] 和 [另一个参考][ref2]。

[ref]: https://example.com/new-ref

一个结尾。

一个类型变化段落。

转义与实体：\*字面星号\*、&、自动链接 [https://example.com/auto](https://example.com/auto)。

![截图](./new-shot.png)

![新增插图](./added-shot.png)

## 第七章 其他

<!-- 这是一条会被修改的新注释 -->

<!-- 这是一条新增加的注释 -->

下面是一段 __加粗__ 和 _斜体_ 文字，还有一段只有 Markdown 写法变化的 __拼写__。

<strong class="new-inline">内联 HTML</strong> 与 🎉 表情符号。

***

### 会被降级的小标题

### 新增的小节

<div class="raw-html-block">新增的 HTML 块</div>

一个很长很长的一行，用来测试横向平移和行号固定：这是第二版的超长行内容，包含一串很长的英文标识符 StructuredPreviewRichFixtureAlphaBetaGammaDeltaEpsilonZetaEtaThetaIotaKappaLambdaMu，以及更多中文内容让这一行足够宽、必须横向滚动才能读完整行。第二版在末尾又加长了一点点。

结尾一行（第二版）。
