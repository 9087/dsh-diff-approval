---
title: 结构化预览综合样本
version: 1
status: draft
draftFlag: true
tags:
  - alpha
  - beta
---

# 第一章 概览

这是第一版的一段普通文字，包含链接 [项目文档](https://example.com/old) 和行内代码 `npm run old`，后面还会继续写一些内容。

这一段会被合并的第一段。

这一段会被合并的第二段。

这一段在新版本里会被整段删除，用来验证删除的段落如何显示成红色幽灵块，并且不能把下一段吞掉。

## 第二章 表格

| 场景 | 应返回 | 备注 |
| --- | --- | --- |
| `None` | `false` | 不弹窗 |
| `All` | `true` | 弹窗 |
| `OldRow` | `true` | 只在旧版本存在的行 |

紧跟在表格后面、表格后没有空行的第一行段落。
这是没有空行紧跟表格的第二行，新版本会改写这一行。

## 第三章 列表

- 普通列表项
- 会被改写的列表项：旧写法
- 会被删除的列表项
- 嵌套列表：
  - 嵌套项一
  - 嵌套项二
- [ ] 未完成的任务
- [x] 已完成的任务

1. 第一步
2. 第二步
3. 第三步

## 第四章 引用

> 引用第一版文字。
>> 嵌套引用旧文字。

## 第五章 代码

```ts
const version = 1
console.log('old')
```

```python
print("python block")
```

## 第六章 链接与图片

行内链接文字 [旧链接文字](https://example.com/page)，以及只改 URL 的 [目标不变](https://example.com/v1) 链接。

参考式链接：[参考链接][ref] 和 [另一个参考][ref2]。

[ref]: https://example.com/old-ref
[ref2]: https://example.com/remove-me

![截图](./old-shot.png)

## 第七章 其他

<!-- 这是一条会被修改的旧注释 -->

<!-- 这是一条会被删除的旧注释 -->

下面是一段**加粗**和*斜体*文字，还有一段只有 Markdown 写法变化的 **拼写**。

<strong class="old-inline">内联 HTML</strong> 与 🎉 表情符号。

---

#### 会被降级的小标题

一个很长很长的一行，用来测试横向平移和行号固定：这是第一版的超长行内容，包含一串很长的英文标识符 StructuredPreviewRichFixtureAlphaBetaGammaDeltaEpsilonZetaEtaThetaIotaKappaLambdaMu，以及更多中文内容让这一行足够宽、必须横向滚动才能读完整行。

![会被删除的插图](./removed-shot.png)

结尾一行。
