---
type: Guide
title: 填写规范
description: 通用知识库的分类规则、元数据约定与维护流程。
tags: [meta]
---

# 填写规范

## 新增文档

管理台支持描述生成、上传整理、模板填空、问答式录入和可选的 MCP 文档导入。所有内容都经过索引更新和格式校验；AI 生成内容默认应人工审核后发布。

## 分类规则

| 内容 | 目录 | type |
|---|---|---|
| 指标定义、统计口径、阈值或基线 | `metrics/` | `Metric` |
| 系统、产品能力、工具和接口用法 | `product/` | `Feature` |
| 协作约定、术语、资源、决策记录 | `team/` | `Context` |
| SOP、排查记录、报告、会议纪要 | `guides/` | `Guide` |
| 可公开访问的文章、标准、调研资料 | `references/` | `Reference` |
| 可复用的空白模板 | `templates/` | `Template` |

## Frontmatter

```yaml
type: Guide
title: 文档标题
description: 一句话摘要
tags: [标签]
owner: 责任角色或维护人
timestamp: "2026-08-14"
status: ready
```

`status` 可为 `ready`、`review` 或 `verify`。只有 `ready` 文档会进入智能问答语料。

## 安全与来源

- 只录入公开资料或已获得共享授权的内容；
- 外部资料在文末使用 `# Citations` 标注来源；
- 不提交密钥、令牌、个人信息、客户数据、内网地址或未经授权的文档镜像；
- 文件名优先使用小写 kebab-case，中文文件名也可使用。
