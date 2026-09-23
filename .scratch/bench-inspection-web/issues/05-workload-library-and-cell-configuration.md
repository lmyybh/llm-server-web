# 05: Workload 全局库页面与 Cell 批量配置、队列与预估（重构）

**What to build:** Workload 全局库的管理页面；Deployment 详情页从库中选 Workload 并批量配置 Cell；全局串行队列与预估耗时适配 Cell 粒度。

**Blocked by:** 04

**Status:** open

- [ ] Workload 库页面：列表（名称 · 种类 · 形状 · 被引用数）+ 新建（选种类 → 合成填 input/output tokens / 数据集从已登记名称中选择）
- [ ] Deployment 详情页配置 Cell：从库中选 Workload → 选 mode（concurrency|qps）→ 输入一组档位值 → **展开成多个 Cell**；`num_requests` 逐 Cell 可改
- [ ] 同一 (Deployment, Workload) 下重复 `(mode, level)` 创建时 409
- [ ] **【跑全部】** = 把该 (Deployment, Workload) 下的 Cell 批量入队；**全局串行队列沿用，最小执行单元是 Cell**
- [ ] 预估耗时 = Cell 数 ×（warmup + 测量时长 + flush），在点开始之前显示；测量时长由 num_requests 与该 Deployment 最近完成 Cell 的延迟估算
- [ ] 两种模式都能跑：闭环（信号量限并发）与开环（固定到达率）

## 沿用自 Run 实现的教训

- **开环模式下短程运行的"达成 QPS"会系统性偏低**：时长包含最后一个请求的完整延迟，那一段不受到达率管辖。不是 bug，但 QPS 档位的 num_requests 要足够多，否则达成率被尾部效应压低而误判。
- **预估耗时**的验证方式：同一个 Cell 跑一次 vs 跑两次，差值才是单点成本；拿不同档位相减得到的是波数差异，不是成本。
