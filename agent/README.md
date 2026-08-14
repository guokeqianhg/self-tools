---
type: Guide
title: Agent 使用说明
description: 通用知识库管理台与命令行工具的部署和使用方法。
tags: [meta, agent]
---

# Agent 使用说明

`agent/` 提供本地优先的 Node.js 管理台和命令行工具，支持文档维护、检索、问答、上传整理和知识治理。

## 启动管理台

```bash
git clone <你的仓库地址>
cd internal-knowledge-base
cp .env.example .env
cd agent && npm install && cd ..
node agent/serve.mjs
```

默认访问地址为 `http://localhost:8080`。生产环境应在网关或反向代理层配置认证、HTTPS 和访问控制。

## 功能

- 新增、编辑、删除、审核和模板填空；
- 本地关键词/向量混合检索与带引用的多轮问答；
- 上传 Markdown、TXT、DOCX、PDF 后自动整理；
- 图片粘贴上传、文档状态门禁、质量校验和治理报告；
- 可选的 MCP 文档导入与聊天归档沉淀。

## 命令行

```bash
node agent/cli.mjs add "编写一个系统接入流程" --domain guides
node agent/cli.mjs search "接入流程"
node agent/cli.mjs ask "如何维护知识文档？"
node agent/cli.mjs reindex --full
```

未配置 `LLM_API_KEY` 时，问答会返回检索结果，文档新增会使用确定性模板；不影响文档库基本功能。

## 安全边界

- `.env`、`.rag/`、聊天归档和运行统计均已被忽略，不应提交；
- 上传或导入前应确认资料具备共享授权；
- 管理台的写接口、聊天归档接口和媒体预览接口必须受到身份认证保护；
- 只有 `metrics/`、`product/`、`team/`、`guides/`、`references/` 下的业务文档允许通过 API 编辑。
