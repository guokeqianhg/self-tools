#!/usr/bin/env node
// 内部知识库 Agent CLI
// 用法:
//   node agent/cli.mjs add <描述...> [--domain X] [--title T] [--owner O] [--dry-run] [--no-push] [--force]
//   node agent/cli.mjs search <关键词...> [--limit N]
//   node agent/cli.mjs ask <问题...> [--top N]
import { execFileSync } from 'node:child_process';
import { addDoc } from './add.mjs';
import { loadDocs, searchDocs } from './scan.mjs';
import { ask, printHits } from './ask.mjs';

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['dry-run', 'no-push', 'force', 'full'].includes(key)) flags[key] = true;
      else { flags[key] = argv[i + 1]; i += 1; }
    } else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `内部知识库 Agent CLI

命令:
  add <描述...>     生成 OKF 文档并 commit + push 到 main
                    选项: --domain metrics|product|team|guides|references
                          --title <标题>  --owner <责任人>
                          --dry-run 只预览不落盘  --no-push 只提交不推送  --force 覆盖同名文件
  search <关键词..> 关键词检索知识库（--limit N，默认 8）
  ask <问题...>     检索 + LLM 问答，回答带文档引用（--top N，默认 5）
  reindex           重建 RAG 向量索引（增量，只 embed 改动块；--full 强制全量重建）

环境变量:
  LLM_API_KEY / LLM_BASE_URL / LLM_MODEL   未配置 LLM_API_KEY 时自动降级（add 用模板、ask 退化为 search）
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const root = repoRoot();
  const input = positional.join(' ').trim();

  switch (cmd) {
    case 'add': {
      if (!input) throw new Error('add 需要一段文档描述，例如: node agent/cli.mjs add "系统接入流程的说明与维护方法"');
      const { rel, pushed } = await addDoc(root, input, {
        domain: flags.domain, title: flags.title, owner: flags.owner,
      }, { dryRun: flags['dry-run'], noPush: flags['no-push'], force: flags.force });
      console.log(`完成: /${rel}${pushed ? '（已推送）' : ''}`);
      break;
    }
    case 'search': {
      if (!input) throw new Error('search 需要关键词');
      printHits(searchDocs(loadDocs(root), input, Number(flags.limit) || 8));
      break;
    }
    case 'ask': {
      if (!input) throw new Error('ask 需要一个问题');
      await ask(root, input, { topK: Number(flags.top) || 5 });
      break;
    }
    case 'reindex': {
      const { reindex } = await import('./embed.mjs');
      const r = await reindex(root, { full: flags.full });
      console.log(`RAG 索引完成：共 ${r.total} 块，本次 embed ${r.embedded} 块。`);
      break;
    }
    case 'help':
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exitCode = 1;
});
