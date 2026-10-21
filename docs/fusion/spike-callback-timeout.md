# Spike: 沙箱内阻塞 HTTP 回调的超时行为（裁决 D5 定案依据）

- 日期: 2026-10-21
- 状态: 已定案（实测完成）
- 验证脚本: 元枢仓库 `backend/scripts/spike_callback_timeout.py`（临时验证产物，不入 fusion 主线）
- 元枢权威版本约束: `models.py:32-34`（单函数 30s / 链 120s / 深度 10）、`executor.py:177-178`（effective_timeout = min(30, 120 - 已耗)）、`sandbox.py:210-235`（sys.settrace 行级 deadline + SIGALRM 降级逻辑）

## 1. 目的

D5 裁决要求"回调客户端必须自带硬超时"。本 spike 用实测回答三个问题：

1. 客户端超时（5s）是否先于沙箱 deadline（实测取 8s）触发？
2. 触发的是客户端的 TimeoutError 还是沙箱的 TimeoutError？
3. 客户端**不带**超时且回调阻塞在 C 层时，沙箱 deadline 是否仍然兜底？

## 2. 方法

- 挂起端点: 本机 `127.0.0.1:18999`，`listen` 后 accept 连接但**永不回包**（accept 得到的连接保持引用，避免 GC 关闭把"挂起"变成"连接被 RST"——首版脚本即因 accepted socket 被 GC 回收，客户端实测到 WinError 10053 连接中止而非阻塞，已修正）。
- 沙箱入口: 元枢 `UnifiedSandbox().execute(code, "f", ns, timeout=8)`，函数体内调用注入的宿主回调 `query_objects('X', {}, 10)`，其内部 `urllib.request.urlopen(...)` 打到 18999。
- 环境: Windows 10 (win32) / Python 3.13.12 / 元枢 backend venv。关键环境事实：**`signal.SIGALRM` 不存在**（`hasattr(signal,'SIGALRM') == False`），沙箱 `sandbox.py:232-235` 的 SIGALRM 分支降级为 `use_alarm=False`，唯一超时机制是 `sys.settrace` 行级 deadline（`sandbox.py:210-220`）。
- S2 有永久挂起风险，脚本内置 watchdog（阻塞超过 deadline + 余量即打印证据并 `os._exit(97)`），shell 层再套 `timeout 60` 双保险。

## 3. 实测结果

### 场景 S1: 客户端超时 5s < 沙箱 8s

```
[S1-client-5s] python=3.13.12 platform=win32 signal.SIGALRM=False client_timeout=5 sandbox_timeout=8
[S1-client-5s] raised builtins.TimeoutError after 5.1s: TimeoutError('timed out')
```

两次运行 5.1s / 5.2s，可复现。**客户端 5s 超时先于沙箱 8s deadline 触发**；异常经沙箱 `execute` 原样透传（finally 正常恢复 settrace/计时器，进程干净退出）。

异常类型要点：`builtins.TimeoutError`（即 `socket.timeout` 的 3.10+ 别名，读超时从 `http.client.getresponse()` 直接逃出，未被 urllib 包装成 `URLError`）。注意**它与沙箱自身超时是同一个类型**（`sandbox.py:249` 抛 `TimeoutError(f"函数执行超时 (>{timeout}s)")`），二者仅能靠消息文本区分——调用方不能按类型区分"回调超时"与"沙箱超时"。

### 场景 S2: 客户端不带超时

```
[S2-no-client-timeout] python=3.13.12 platform=win32 signal.SIGALRM=False client_timeout=None sandbox_timeout=8
[S2-no-client-timeout] STILL BLOCKED after 20s (已超过沙箱 8s deadline，期间无 TimeoutError、无输出) -> 沙箱永久挂起，强制终止
```

**沙箱永久挂起，需外部杀死进程**（watchdog 在 20s 强制终止，退出码 97；期间沙箱 8s deadline 已过 2.5 倍仍无任何异常）。

根因链：客户端无超时 → `urlopen` 阻塞在 C 层 `socket.recv` → 解释器不执行任何字节码 → `sys.settrace` 的 deadline 检查（`sandbox.py:216`）得不到 trace 事件、永不执行 → Windows 又无 SIGALRM 兜底 → 挂起无界。

对照实验（证明不是 deadline 机制本身失效）：纯 Python 死循环进沙箱 `timeout=3`，实测 `builtins.TimeoutError after 3.0s: 函数执行超时 (>3s)`——只要解释器在跑字节码，deadline 正常生效。**失效点精确限定在"C 层阻塞调用"**。

## 4. D5 契约定案

1. **回调客户端必须自带硬超时，取 5s**：小于沙箱单函数上限 30s、小于链预算（executor `effective_timeout = min(30, 120 - 已耗)`）；这是实测（S2）证明的唯一可靠兜底——C 层阻塞时沙箱 deadline 必然失效，客户端超时是唯一会触发的机制。
2. 边界说明（如实记录）：当链剩余预算被耗到 < 5s 时，沙箱会先于客户端触发；此时若回调已阻塞在 C 层，沙箱同样无法触发，仍由客户端 5s 兜底。两种次序下总耗时都有界（≤ max(5s, effective_timeout)），满足契约。
3. **回调失败即抛 RuntimeError，不重试**：S1 证实客户端超时以 `TimeoutError('timed out')` 形态出现，与沙箱超时同类型、仅消息可分；回调客户端层应将其捕获并转换为带上下文的 `RuntimeError`（而非依赖类型判别），直接失败不重试。
4. 若未来在 Linux 主线程部署，沙箱会启用 SIGALRM（`sandbox.py:226-231`），C 层阻塞可被 EINTR 打断、deadline 可兜底；但当前 Windows/工作线程环境无此保障，**不能依赖沙箱兜底**，D5 的"客户端必须带 5s 硬超时"为硬性要求。

## 5. 复现

```bash
cd 元枢仓库
timeout 90 ./backend/venv/Scripts/python.exe -u backend/scripts/spike_callback_timeout.py client-timeout   # S1
timeout 60 ./backend/venv/Scripts/python.exe -u backend/scripts/spike_callback_timeout.py no-timeout      # S2（挂起风险，勿裸跑）
```
