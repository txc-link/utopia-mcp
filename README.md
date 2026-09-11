# utopia-mcp

Utopia —— 本体系统唯一真源的 MCP 服务器。

实现依据：**本体系统架构 ADR v1.0**（TDAI Team Wiki `wiki-ar156gei` → `ADR-0001-本体系统架构-v1.0.md`，需团队凭据访问）。

核心约定速览：

- 唯一真源：本体 Schema 只存在于 Utopia
- 只 append：修正以「写入新断言 + 标记 `superseded_at`」实现，历史永不删除
- 只有 `approved` 参与推理与对外服务
- Agent 只能 `propose`，不能自行 `approve`
- 执行结果不能自我认证为权威事实

## 定位

四层架构中的**知识真源层**：

| 层 | 职责 |
| --- | --- |
| **Utopia** | 本体类型/属性/关系、经审核的权威事实、双时态、证据、推理（**本仓库**） |
| Agora | Action 执行与多 Agent 编排 |
| TDAI | 跨工具对话记忆与偏好 |
| Project Brain | 人类说明、ADR、操作手册、Utopia 只读导出快照 |

## 核心不变量

1. **单一真源** —— Schema 只存在于 Utopia
2. **只 append，永不 UPDATE** —— 修正以写入新断言 + 标记 `superseded_at` 实现
3. **只有 `approved` 参与推理与对外服务**
4. **Agent 只能 propose，不能自行 approve**（§2.6 权限原则）
5. **执行结果不能自我认证为权威事实** —— Action 回写只写 evidence 与 candidate

## 工具

### 只读

| 工具 | 用途 |
| --- | --- |
| `ontology_type_list` / `ontology_type_get` | 查类型定义 |
| `ontology_entity_search` / `ontology_entity_get` | 查实体 |
| `ontology_statement_query` | 查事实（支持 `as_of` / `as_recorded` 双时态语义） |
| `ontology_evidence_get` | 查证据与溯源链 |
| `ontology_vocabulary` | 读受控词表 |

### 写

| 工具 | 用途 |
| --- | --- |
| `ontology_statement_propose` | 提交 candidate（Agent 入口） |
| `ontology_statement_review` | 审批流转（**高权限**） |

## 状态机

```
candidate ──▶ under_review ──▶ approved ──▶ deprecated
     │              │
     └──────────────┴──▶ rejected ──▶ candidate
```

非法流转被 `ont_transition()` 拒绝；所有流转写入 `ont_review_log`（绕过函数直接 UPDATE 也有触发器兜底）。

## 双时态

| 维度 | 字段 |
| --- | --- |
| 业务时间 | `valid_from` / `valid_to` |
| 系统时间 | `recorded_at` / `superseded_at` |

- `ont_as_of(subject, t)` —— 某业务时点成立什么
- `ont_as_recorded(subject, t)` —— 某系统时点我们以为什么

## 运行

```bash
pnpm install
pnpm run build
UTOPIA_DB_URL=postgresql://...  UTOPIA_TOKEN=...  node dist/index.js
```

服务暴露 `GET /health`（免鉴权）与 `POST /mcp`（需 `Authorization: Bearer $UTOPIA_TOKEN`）。

## 部署

见 `deploy/docker-compose.yml`。生产部署复用 `/opt/utopia/.env`，容器加入 `utopia_default` 网络，仅监听 `127.0.0.1:18425`，对外由 Caddy 提供 TLS 反代。
