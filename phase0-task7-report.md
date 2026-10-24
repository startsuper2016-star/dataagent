# Phase 0 Task 7 报告 — Spike: 沙箱内阻塞 HTTP 回调的超时行为（D5 定案依据）

- 日期: 2026-10-21
- 状态: DONE
- Commit: `b94160e` — `phase0: callback timeout behavior verified`（已推送 `origin/main`，`6604d13..b94160e`）

## 产出

| 产物 | 位置 | 说明 |
|---|---|---|
| Spike 脚本 | `C:\Users\shuan\Downloads\ontology-master (3)\ontology-master\backend\scripts\spike_callback_timeout.py` | 元枢仓库临时验证产物，按约定不入 git（该目录非 git 仓库） |
| Spike 文档 | `C:\Users\shuan\Documents\GitHub\datafoundry\docs\fusion\spike-callback-timeout.md` | 实测三值 + D5 契约定案，已入库并推送 |
| 本报告 | `C:\Users\shuan\Documents\GitHub\datafoundry\phase0-task7-report.md` | — |

## 实测结果

环境: Windows 10 (win32) / Python 3.13.12（backend venv）/ 元枢 `UnifiedSandbox`（`backend/app/services/function_runtime/sandbox.py`）。关键环境事实: `signal.SIGALRM` 不存在（`hasattr(signal,'SIGALRM') == False`），沙箱 `sandbox.py:232-235` 降级为 `use_alarm=False`，唯一超时机制是 `sys.settrace` 行级 deadline（`sandbox.py:210-220`）。

### 场景 S1: 回调客户端带 5s 超时（沙箱 deadline 取 8s）

```
[S1-client-5s] raised builtins.TimeoutError after 5.1s: TimeoutError('timed out')
```

两次运行 5.1s / 5.2s，可复现。**客户端 5s 超时先于沙箱 8s 触发**；异常为 `builtins.TimeoutError('timed out')`（`socket.timeout` 的 3.10+ 别名，读超时从 `http.client.getresponse()` 直接逃出，未被 urllib 包装成 `URLError`），经沙箱 `execute` 原样透传，finally 正常恢复 settrace/计时器，进程干净退出。

### 场景 S2: 回调客户端不带超时

```
[S2-no-client-timeout] STILL BLOCKED after 20s (已超过沙箱 8s deadline，期间无 TimeoutError、无输出) -> 沙箱永久挂起，强制终止
```

**沙箱永久挂起，需外部杀死**（脚本 watchdog 20s 强制终止，退出码 97；沙箱 8s deadline 已过 2.5 倍仍无任何异常）。根因链: 无客户端超时 → `urlopen` 阻塞在 C 层 `socket.recv` → 解释器不执行字节码 → `sys.settrace` deadline 检查（`sandbox.py:216`）得不到 trace 事件、永不执行 → Windows 无 SIGALRM 兜底 → 挂起无界。

### 对照实验（证明非 deadline 机制本身失效）

纯 Python 死循环进沙箱 `timeout=3`，实测 `builtins.TimeoutError after 3.0s: 函数执行超时 (>3s)`。失效点精确限定在"C 层阻塞调用"期间。

## D5 契约定案

1. 回调客户端必须自带 5s 硬超时（< 沙箱单函数 30s、< 链 120s 剩余预算）——S2 证实这是 C 层阻塞时**唯一**会触发的兜底机制，不能依赖沙箱 deadline。
2. 边界: 链剩余预算 < 5s 时沙箱可能先触发；若此时回调已阻塞在 C 层，沙箱同样无法触发，仍由客户端 5s 兜底。两种次序总耗时均有界。
3. 回调失败即抛 RuntimeError、不重试——S1 证实客户端超时与沙箱超时**同类型**（均为 `TimeoutError`），仅消息可分（'timed out' vs '函数执行超时 (>Ns)'），回调客户端层应捕获后转换为带上下文的 RuntimeError，不依赖类型判别。

## 过程备注（影响复现的坑）

- 首版挂起端点的 accept 循环未保留 accepted socket 引用，socket 被 GC 关闭导致客户端 0.2s 实测到 `ConnectionAbortedError(10053)`（连接被 RST）而非阻塞——已修正为持有引用（brief 原始写法 `[s.accept() for _ in range(10)]` 用列表持有引用，等价正确）。
- S2 脚本内置 watchdog（阻塞超限打印证据并 `os._exit(97)`），shell 层 `timeout 60` 双保险；S1 外层 `timeout 90` 兜底。
- 8001 端口冲突未影响本 spike（未起 uvicorn，`sys.path.insert` 方式导入 sandbox）；并行会话期间未检测到干扰。
- 中途无并行会话把 8001 拉起造成的干扰（spike 全程不依赖 8001）。

## 疑虑

无阻塞项。唯一值得留意的边界: 若未来部署到 Linux 主线程，SIGALRM 分支启用后沙箱可打断 C 层阻塞，但当前环境（Windows / 工作线程）无此保障，D5 的客户端硬超时要求保持硬性。
