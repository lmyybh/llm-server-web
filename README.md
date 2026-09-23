# llm-server-web

对**已在运行**的 LLM 推理服务做性能压测与接口巡检的网站。

- 领域词汇 → [`CONTEXT.md`](./CONTEXT.md)
- 设计文档 → [`docs/design.md`](./docs/design.md)
- 需求规格 → [`./.scratch/bench-inspection-web/spec.md`](./.scratch/bench-inspection-web/spec.md)
- 工单 → [`./.scratch/bench-inspection-web/issues/`](./.scratch/bench-inspection-web/issues/)

本站**自己实现**负载发生，不依赖 `aib` 或 `llm_tools`；只把它们的源码作为实现参考。

## 两个系统

|  | 压测 | 巡检 |
|---|---|---|
| 回答的问题 | 这台服务能扛多少 | 这台服务现在正常吗 |
| 实体 | Workload（全局库）；Model → Deployment → Cell | Service → Inspection Run |
| 产物 | 曲线、分布、对比 | 用例红绿灯 |
| 耗时 | 分钟到小时 | 十几秒 |

**两者不共享任何实体。** 同一个 URL 如果既要压测又要巡检，要在两处各配一次——这是刻意的。它们由不同的人按不同的节奏做，强行关联只会引入一个两边都要维护的中间实体。

## 组成

| 目录 | 内容 |
|---|---|
| `backend/llmbench/` | 测量内核：SSE 解析、逐请求计时、并发与到达率、workload 形状、数据集 |
| `backend/llmbench/inspection.py` | 巡检引擎：目标发现、11 个用例、判定 |
| `backend/server/` | Web 应用：SQLite 持久化 + HTTP API + 两个执行器子进程 |
| `backend/tools/parity.py` | 与 `aib` 的对拍工具（压测侧唯一的集成测试） |
| `tools/gateway_proxy.py` | 本地复现网关形态（见下） |
| `frontend/` | Next.js 14 + TypeScript + Tailwind |

## 运行

```bash
cd frontend && npm install    # 首次
cd .. && ./run.sh             # dev，两端都带热重载
./run.sh prod                 # 构建前端后以生产模式运行
```

`run.sh` 同时起后端与前端，Ctrl-C 会一起收掉。配置项见 [`.env.example`](./.env.example)。

**后端只监听回环地址**：浏览器从不直接访问它。Next 在服务端把 `/api/*` 转发到 `BACKEND_URL`（默认 `http://127.0.0.1:8000`），所以：

- 浏览器全程同源，**CORS 在部署形态下根本不参与**
- 后端不需要额外的网关路由，也不需要暴露端口
- 直接 `curl :8000` 仍然可用（对拍工具与脚本走这条路）

### 停服务

**给 `run.sh` 发一个 SIGTERM 就够了**，它会把两边一起收掉：

```bash
kill -TERM "$(pgrep -f '[r]un\.sh dev' | head -1)"
```

`run.sh` 用 `set -m` 让两边各自成为一个**进程组**，所以一次 `kill -- -<pid>` 能到达 npm 的孙子进程。这解决了一个真实问题：早先前端跑在前台，杀 `next-server` 会把它上面的 `next dev` 父进程留下，重启几次之后就攒了八个。

如果 `run.sh` 已经不在（比如被 `kill -9`），按端口定位。**这台机器上没有 `lsof` 也没有 `fuser`**，`ss` 是有的：

```bash
for p in 6006 8000; do
  for pid in $(ss -lntpH | grep -E ":$p\b" | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$pid"; done
done
```

**不要用 `pkill -f <名字>`。** 它有两个坑，都真实发生过：它会匹配到**执行它的那个 shell 自己**（命令行里就含那个字符串）；而且它会匹配到**别的项目**的同名进程——这台机器上 `chat-web` 的 `next dev` 就是这么被打挂过一次。

要判断一个进程是不是本项目的，看它的工作目录：

```bash
readlink /proc/<pid>/cwd
```

## 部署到网关后面

默认就是按网关形态配置的（`run.sh` 里给的默认值）：

| 变量 | 默认值 |
|---|---|
| `PORT` | `6006` |
| `NEXT_PUBLIC_GATEWAY_PREFIX` | `/api/gateway/tensorboard/kf-partition/nbser-chengguoliang-gpu` |
| `LLMBENCH_ALLOWED_ORIGINS` | `https://arsenal.weizhipin.com,https://arsenal-gateway.weizhipin.com` |

这三个默认值取自 chat-web 的 `run.sh`。**本站与 chat-web 在该网关路径上互斥**——同一条路径只能指向一个应用，所以两者不能同时占用。

该值在 `next build` 时被内联，**修改后必须重新构建**。设置后：

| 浏览器请求 | 网关剥掉前缀后，Next 收到 | 处理 |
|---|---|---|
| `<前缀>/_next/*` | `/_next/*` | Next 自己（`assetPrefix`） |
| `<前缀>/api/*` | `/api/*` | 反代到后端 |
| `<前缀>/models/1` 等页面 | `/models/1` | Next 自己 |

网关侧只需要**一条路由**：`<前缀>/*` → 前端端口。

### 前缀不是 `assetPrefix` 一个配置就够的

`assetPrefix` **只给静态资源加前缀**，不给客户端路由要跳转的 URL 加。chat-web 是单页应用、从不发生客户端跳转，所以它没暴露这个问题；本站有子路由，一点就跳到 `<站点根>/models/1`——那条路径不在网关的路由表上，于是 404。

所以：**内部链接一律用 `app/components/Link.tsx`，不要直接用 `next/link`**。它会把前缀加回去。

### 本地复现网关形态

`npm run dev` 的形态和部署形态差别足够大，能藏住 bug（本地每条路由都通，经网关就 404）。用 `tools/gateway_proxy.py` 把部署形态搬到本机：

```bash
# 一个终端：带前缀起前端
NEXT_PUBLIC_GATEWAY_PREFIX=/gateway/llm-bench PORT=6006 ./run.sh dev

# 另一个终端：剥前缀的代理
python3 tools/gateway_proxy.py \
    --prefix /gateway/llm-bench --port 7777 --upstream http://127.0.0.1:6006

# 然后访问 http://127.0.0.1:7777/gateway/llm-bench/
```

**凡是改动链接、路由或资源路径，都要经这个代理验一遍再上。**

若网关**不传递** `X-Forwarded-Host`，浏览器发来的 `Origin` 与后端看到的 `Host` 对不上，写操作会被 CSRF 防护拒绝。此时把网关的对外 Origin 加进白名单：

```bash
LLMBENCH_ALLOWED_ORIGINS=https://arsenal.weizhipin.com,https://arsenal-gateway.weizhipin.com
```

### 为什么写操作要查 Origin

v1 没有登录，所以**任何能触达这个 API 的页面都能替你建模型、改部署**。CORS 挡不住它——跨站的 POST 照样会执行，浏览器只是不把*响应*交给攻击者。所以 `POST`/`PATCH`/`DELETE` 在 Origin 说不清来源时直接 403。放行条件是：无 Origin（curl、服务端调用）、同主机任意端口（开发时前端与 API 不同端口）、或在 `LLMBENCH_ALLOWED_ORIGINS` 里。

## 测试

```bash
cd backend && python3 -m pytest         # 测量内核 + API
cd frontend && npm test                 # 组件测试（vitest + testing-library）
cd frontend && npm run typecheck && npm run lint && npm run build
```

## 压测内核的单独使用

测量内核可以脱离网站单独对一台服务跑一次：

```bash
cd backend
python3 -m llmbench \
  --url http://<router-host>:<port> \
  --model <model-name> \
  --input-tokens 1024 --output-tokens 128 \
  --concurrency 8 --num-requests 64 --warmup 8
```

每一档都执行 `warmup → flush_cache → 计时`。**flush 不可关闭**——一旦可选，数字就多出一根不可比轴。

**计时口径**：TTFT 与 E2E 从请求**真正发出**的时刻起算，排队等待并发许可的时间不计入。所以高并发档位呈现的是**服务时间**，不是用户感知的响应时间。

## 对拍

验证自研负载发生器与 `aib` 的口径一致。**这是本项目唯一的集成测试**（不建 mock 目标服务）：

```bash
cd backend
python3 tools/parity.py --url <router> --model <name> \
  --input-tokens 1024 --output-tokens 128 --concurrency 8 --num-requests 64
```

每边跑 3 次独立进程（warmup 与 flush 是每进程一次）。判据是 `差距 ≤ max(固定容差, 两侧各自的 run 间波动)`；当容差来自噪声时用 `*` 标出——**p99 类指标在几十个样本下波动可达 40%**，这不是两套实现不一致的证据。
