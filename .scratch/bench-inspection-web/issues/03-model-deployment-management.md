# 03: 数据模型与 Model / Deployment 管理

**What to build:** 用户能在页面上建一个 Model，并在它下面建多个 Deployment——填一次 router URL、发送给服务的模型名、API key 所在的**环境变量名**与部署元数据；能看到列表。

**Blocked by:** 02

**Status:** done

- [x] 创建并列表展示 Model
- [x] 在同一个 Model 下创建多个 Deployment，并列表展示
- [x] Deployment 可编辑；编辑立即生效，**不产生新实体**
- [x] **只存 API key 所在的环境变量名，永不落盘、永不入库、永不写入产物**
- [x] 只登记一个 router URL——PD 分离架构也只寻址入口，不枚举 prefill / decode worker
- [x] Deployment 上有一个**生成上限**参数（合成 workload 的输入 token 数封顶），带一个合理默认值

## 验证记录

**后端 129 个测试**（`backend/tests/`，其中 51 个是本工单新增），**前端 11 个组件测试**（`frontend/tests/`）。`tsc --noEmit`、`next lint`、`next build` 全绿。

**端到端跑通**：起真实 uvicorn + Next.js，经 API 建了 Model 与 Deployment，CORS 预检返回 200 且带上 `http://localhost:3000`。两个页面在浏览器渲染前都能返回 200 与服务端外壳。

**前端测试用的是有状态的假后端**（`frontend/tests/helpers.ts`），不是固定返回值——所以"填表 → 提交 → 列表刷新"这条链路是真的被走了一遍，固定返回值的 mock 在页面忘记刷新时也会通过。

### 凭据纪律的三层验证

不写密钥这件事有三级测试，最后一级是最强的：

1. `api_key_env` 只接受合法的环境变量名；`sk-live-abc123`、`sk.abc123`、`1234ABC`、`my key`、`abc-123` 一律 422
2. 请求体里塞 `api_key` / `key` / `token` 字段，既不在响应里回显，也不出现在任何读取接口
3. **直接读数据库文件字节**（含 WAL），断言密钥不在磁盘上

第 3 条才是"永不落盘"的字面含义；前两条只证明"不外泄"。

### 两个实现判断

- **`api_key_env` 的校验是结构性的，不是黑名单**：POSIX 环境变量名不能含 `-`、`.`、不能以数字开头，而真实 API key 几乎必然含这些字符。所以粘贴密钥会在这里失败，而不是被写进磁盘。
- **Deployment 可变，且不产生新实体**（有测试锁住）。这个取舍的正当性来自设计文档：正确性由 Cell 上的执行快照保证，不由实体的不可变性保证。

### 尚未做

- Model 的重命名/改备注只有 API 与测试，**没有界面**——工单未要求，属于后续
- 巡检入口在导航里是灰的，对应工单 13
