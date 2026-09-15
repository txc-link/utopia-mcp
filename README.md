# utopia-mcp-adapter

官方 Utopia 的 MCP 兼容适配层。它不保存本体数据，也不直接连接 PostgreSQL；所有查询和写入都通过官方 Utopia REST API 或其内置 MCP 完成。生产部署仍以官方 Utopia 为唯一事实与审核权威。

## 工具

适配器同时暴露：

- 官方工具：`search_chunks`、`get_document`、`search_docs`、`find_entities`、`entity_facts`、`changes`、`remember`
- 旧兼容工具：`ontology_type_list/get/upsert/review`、`ontology_entity_search/get/upsert`、`ontology_statement_query/propose/review`、`ontology_evidence_get`、`ontology_vocabulary`

## 写入语义

| 旧工具 | 官方 Utopia 映射 |
| --- | --- |
| `ontology_type_upsert` | 官方本体工作台 REST API；Schema 保存后立即生效并进入官方审计台账 |
| `ontology_entity_upsert` 更新已有实体 | 官方实体 `PATCH` API |
| `ontology_entity_upsert` 创建实体 | 官方 `remember`，等待抽取后返回 Utopia 分配的实体 UUID；超时则失败关闭 |
| `ontology_statement_propose` | 官方 `remember`，等待并返回官方 candidate UUID；超时则失败关闭 |
| `ontology_statement_review(...approved)` | 官方 `confirm` |
| `ontology_statement_review(...rejected)` | 官方 `reject` |

`ontology_statement_query` 会合并官方已确认事实与待审 candidate，并明确标记状态；只有 `approved` 属于已发布图谱。官方 v0.1 API 不支持旧系统的任意实体 ID、类型状态机、`evidence_id` 反查或精确 `as_recorded` 接口。适配器会返回明确说明，不会偷偷恢复第二套数据库。

兼容调用使用临时主体 ID 发起 `ontology_statement_propose` 时，响应会同时返回稳定的 `official_subject_id`。临时 ID 到官方 ID 的别名只保存在当前适配器进程中；跨重启调用应保存并改用 `official_subject_id`。

## 环境变量

- `UTOPIA_TOKEN`：调用适配器的外部 Bearer Token
- `UTOPIA_API_BASE`：官方 Utopia 地址，例如 `http://host.docker.internal:1516`
- `UTOPIA_KB_ID`：唯一权威知识库 ID
- `UTOPIA_API_EMAIL` / `UTOPIA_API_PASSWORD`：REST API 服务身份；只保存在服务器权限为 600 的环境文件中
- `UTOPIA_PAT`：绑定该知识库的官方写入 PAT；只用于官方 MCP
- `UTOPIA_CANDIDATE_WAIT_MS`：等待官方实体/candidate 可寻址的窗口，默认 90000，范围 5000–120000 毫秒
- `UTOPIA_REVIEW_ENABLED=1`：显式开启高权限 confirm/reject；默认关闭，避免普通 MCP token 越过人工审核边界

服务提供免鉴权的 `GET /health` 与需要外部 Bearer Token 的 `POST /mcp`。
