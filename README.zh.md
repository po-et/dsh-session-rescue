# dsh-session-rescue

**修复 DeepSeek Harness 的 "history unavailable … corrupt session log"——安全、常见场景零丢失。**

[English](README.md)

```sh
npx github:po-et/dsh-session-rescue
```

如果你见过这些报错，这个工具就是为你写的：

- `corrupt session log: seq gap in committed region at line N (expected X, got Y)`
- `corrupt session log: unparsable committed event at line N`
- `first line is not a session header`
- 崩溃 / 强杀进程 / 双开实例之后的 `SessionPersistenceCorruptionError`

dsh 的会话日志是 append-only 且严格校验的：崩溃恢复或第二个进程多写了一段重复事件，整个会话就永远打不开——但**你的内容其实几乎都还在**。`dsh-session-rescue` 按 dsh 加载器的原样规则定位损坏点，摘除冗余侧（重放行、过期的合成中断收尾块），重建一个可加载的日志。

## 快速开始

> `npx github:…` 首次运行会从源码构建（约半分钟），之后有缓存。发布到 npm 后也可以用更短的 `npx dsh-session-rescue`。

```sh
# 1. 看哪些会话坏了（只读，绝对安全）
npx github:po-et/dsh-session-rescue

# 2. 深度诊断某个会话（路径或 id 片段均可）
npx github:po-et/dsh-session-rescue doctor 37374e34

# 3. 预览修复方案——此时不写任何东西
npx github:po-et/dsh-session-rescue repair 37374e34

# 4. 执行修复（自动保留带时间戳的备份；请先关闭 dsh）
npx github:po-et/dsh-session-rescue repair 37374e34 --apply
```

修不了的也能救回对话内容：

```sh
npx github:po-et/dsh-session-rescue export 37374e34        # 抢救对话全文为 Markdown
npx github:po-et/dsh-session-rescue quarantine 37374e34    # 把坏会话移出 dsh 视野，防止拖垮启动
```

在用 AI agent？直接对它说：**"运行 `npx github:po-et/dsh-session-rescue`，把我损坏的 dsh 会话修好。"**

## 能修什么

| 损坏 | 成因 | 修复方式 |
|---|---|---|
| 重放的重复行 | 崩溃 / 强杀 / write-behind 重放 | 去重——**零丢失** |
| 合成收尾块与真实续写撞号 | 中断恢复 + 第二写入方 | 摘除合成块、保留真实内容——**零丢失** |
| zstd 尾帧撕裂 | 写入中断电 | 无需处理（dsh 自愈，工具会明说） |
| header 损坏 | 手工编辑、部分写入 | 重建 header |
| 真实 seq 空洞（事件确实丢了） | 强制压缩、写入丢失 | 显式 `--truncate` 保住可加载前缀；`export` 抢救其余 |

两条修复路径都有按实地报告建模的回归测试：[deepseek-harness#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497) 里报告的两种损坏形态（中断收尾块与恢复后的真实工具结果撞号；从回收 seq 整尾重写），工具的输出与这些用户手工验证过的修法一致。

## 为什么安全

社区案例证明：外行修复可能把会话**修死**（悬空 `sourceEventSeqs` 毒化，永久报废）。本工具：

1. **不备份，不动原文件**——带时间戳的备份就放在原文件旁边。
2. **写前验证**：重建结果必须通过 seq 连续性与 `sourceEventSeqs` 引用检查（与 dsh 自身校验一致），不安全的方案直接拒绝执行。
3. **写后复检**：修复完成立刻重扫，若仍无法加载会如实报告，备份完好无损。
4. **保留原始字节**：保留的行原样复制，绝不重新序列化。
5. 按 dsh 的物理布局重建（zstd 帧 0 仅含 header 行）。

## 与其他工具的关系

| | dsh-session-rescue | doctor 类工具 | export 类工具 |
|---|---|---|---|
| 检测损坏 | ✅ | ✅ | — |
| **把会话修到能加载、能继续用** | ✅ | ❌ | ❌ |
| 修不了时抢救对话全文 | ✅ | ❌ | ✅ |
| 拒绝不安全写入 | ✅ | 不适用 | 不适用 |

## 范围与诚实声明

- 支持会话格式 **version 0**（当前 dsh developer preview），`.jsonl` 与 `.jsonl.zstd`，仅 JSONL 后端。dsh 处于 pre-1.0、无格式兼容承诺；遇到未知版本本工具会明确拒绝而不是乱猜。
- 修复时请**关闭 dsh**（至少保证该会话空闲）——活跃写入方会与文件替换竞争。
- 零依赖。Node ≥ 22.15（使用内置 zstd）。

## 许可证

[MIT](LICENSE)
