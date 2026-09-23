# llm-server-web

LLM 推理服务的压测与巡检网站。领域词汇见 `CONTEXT.md`，设计见 `docs/design.md`。

## Agent skills

### Issue tracker

Issue 与 spec 以 markdown 文件形式存放在 `.scratch/` 下。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准 triage 角色，标签字符串与角色名一致。见 `docs/agents/triage-labels.md`。

### Domain docs

单 context：根目录 `CONTEXT.md`，ADR 在 `docs/adr/`。见 `docs/agents/domain.md`。
