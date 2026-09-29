# 业务需求管理系统 API 契约

本项目当前以 Node.js REST 服务和 SQLite 实现本地数据存储；浏览器只提供 HTTP 仓储访问 API。浏览器 `localStorage` 仅可保留无敏感展示偏好，以及在显式开启本地演示身份时保存该演示身份；绝不是业务数据源。生产环境必须由云端 API 和数据库作为唯一可信源。服务端必须最终校验认证、角色、字段权限、状态流转、并发更新和审计记录。

生产前端不得直接读写 `localStorage` 中以 `brms-` 开头的业务数据。前端仅通过 HTTP 仓储发起请求，不提供本地业务仓储或浏览器业务数据回退路径。

## 接口

- `GET /api/me`：返回当前用户、角色、权限。
- `GET /api/workbench?status=`：返回当前身份的待办工作台聚合数据 `{ cards, activeStatus, total, items }`。`cards` 由服务端按角色授权计算，`items` 直接复用业务需求实体字段、按更新时间倒序且最多返回 5 条；`status` 只能为当前身份可见的待办分类，越权时返回 `FORBIDDEN`。页面展示字段、状态与节点均以该接口和需求详情接口为准，前端不得自行计算待办数量或角色可见范围。
- `GET /api/archives?keyword=`：返回由服务端按“已手动归档，或完成发布且发布日期已满六个月”规则筛出的归档数据 `{ cutoff, total, groupCount, items }`；`items` 已按项目和版本完成编组。业务需求方只能获取其本人发起或归属的归档需求，其他角色按授权范围返回。
- `GET|POST /api/users`、`PATCH /api/users/{id}`：用户配置。创建用户时，服务端依据当前登录操作者写入并返回 `createdBy`；创建人不可编辑。用户不提供删除接口。
- `GET|POST /api/projects`、`GET|PATCH /api/projects/{id}`：项目配置；项目名称去首尾空白后全局唯一，重复时返回 `PROJECT_NAME_CONFLICT`。创建项目时，服务端依据当前登录操作者写入并返回 `createdBy`；创建人不可编辑。项目不提供删除接口。
- `GET|POST /api/project-versions`、`GET|PATCH|DELETE /api/project-versions/{id}`：项目版本管理。创建及更新必须携带 `projectId`、`version`、`releaseDate`；同一项目下版本号唯一。已被需求以 `projectId + version` 关联的版本不可删除。
- 需求进入“产品设计”时，客户端通过项目版本列表按 `projectId` 查询版本并支持版本号搜索；状态动作请求必须提交该项目下存在的 `version`，服务端返回并持久化对应的 `releaseDate`。
- `GET /api/requirements?keyword=&projectId=&status=&source=&requesterOwnerId=&createdFrom=&createdTo=&sortBy=&sortOrder=&page=&pageSize=`：需求列表。筛选、排序和身份可见范围必须由服务端执行；业务需求方仅能读取本人发起或归属的需求。
- `POST /api/requirements`、`GET|PATCH /api/requirements/{id}`、`GET /api/requirements/{id}/history`：需求创建、详情、编辑和历史。所有已认证角色均可创建需求。创建和更新响应必须返回服务端生成的 `id`、`code`、`version` 和 `updatedAt`。
- `POST /api/requirements/{id}/actions`：状态动作。请求体携带 `{ "action": "startProductDesign", "version": "9.28.0", "updatedAt": "..." }`；发布时携带 `{ "action": "release", "releaseDate": "2026-09-24", "updatedAt": "..." }`。已完成发布的需求可由产品或系统管理员以 `{ "action": "archive", "updatedAt": "..." }` 手动归档；归档保持原状态并写入归档时间与流转历史。`updatedAt` 是乐观锁版本，冲突时返回 `STATE_CONFLICT` 和最新记录摘要。

## 状态机

| 动作 | 角色 | 前置状态 | 目标状态 | 必填补充 |
| --- | --- | --- | --- | --- |
| `pass` | 初筛专员 | 待评估 | 待预审 | 无 |
| `return` | 初筛专员 | 待评估 | 待需求方重新评估 | `reason` |
| `resubmit` | 业务需求方 | 待需求方重新评估 | 待评估 | 无 |
| `pre` | 产品 | 待预审 | 待投产 | `productOwnerId` |
| `preReturn` | 产品、系统管理员 | 待预审 | 待需求方重新评估 | `reason` |
| `directToProduction` | 产品 | 待需求方重新评估 | 待投产 | `productOwnerId`；仅用于需求已退回、且产品确认无需再次评审的情况 |
| `startProductDesign`（开始产品设计） | 产品 | 待投产 | 产品设计 | `version` |
| `startEngineering`（开始研发实施） | 产品 | 产品设计 | 研发实施 | 无 |
| `release` | 产品 | 研发实施 | 完成发布 | `releaseDate` |
| `archive`（需求归档） | 产品 / 系统管理员 | 完成发布 | 完成发布 | 无；写入归档标记与审计历史 |
| `withdraw` | 发起人 | 非终态且未进入待投产 | 需求撤销 | 无 |
| `terminate` | 产品 / 系统管理员 | 待投产及之后的非终态 | 需求终止 | `reason` |

核心需求字段包括需求编号、需求简述、详细描述 HTML、需求来源、项目、产品 Owner、需求方 Owner、需求补充说明、产品·补充说明、研发·补充说明、版本、状态、发布日期、终止原因和历史。需求补充说明可由需求方随时追加；产品·补充说明可由产品在待预审及之后追加；研发·补充说明可由研发在待投产及之后追加。系统管理员可维护三类说明。创建时需求方 Owner 固定为当前创建人。富文本白名单为 `p`、`br`、`b`、`strong`、`i`、`em`、`u`、`ul`、`ol`、`li`。

## 需求编号

服务端在创建时生成需求编号，客户端不可传入或修改。格式为 `{项目名称拼音首字母}-{ID}`：项目名称先移除“业务”和“App”（不区分大小写），再取其余文字的拼音首字母，且该拼音段最多保留前 4 位；`ID` 在同一项目内从 `001` 起按创建顺序递增。例如“返现业务”的首个需求为 `FX-001`，“羊毛省钱业务”的首个需求为 `YMSQ-001`。未关联项目时使用 `WLX-{ID}`，`WLX` 表示未关联项目。

编号生成必须在创建需求的数据库事务内完成。建议在 `project_requirement_sequences` 表中以 `project_id` 为键执行行级锁或原子递增，避免多用户并发创建时产生重复编号。

## 存储与一致性

数据库建议使用 MySQL 8.0 或 PostgreSQL。时间统一按 UTC 写入，API 使用 ISO 8601（例如 `2026-09-24T10:23:35Z`）；前端仅负责按用户时区显示。富文本保存为经过服务端白名单清洗后的 HTML，同时可派生纯文本字段用于检索。

核心表与关系：

| 表 | 主键 | 关键字段与约束 |
| --- | --- | --- |
| `users` | `id` | `name`、`department`、`role`、`status`；名称按租户唯一 |
| `projects` | `id` | `name`、`name_normalized`、`project_type`、`description`、`status`；`name_normalized` 唯一 |
| `project_versions` | `id` | `project_id`、`version`、`release_date`；`UNIQUE(project_id, version)` |
| `requirements` | `id` | `code`、`project_id`、各 Owner 外键、富文本字段、状态、版本、发布日期、`updated_at`；`code` 唯一 |
| `requirement_histories` | `id` | `requirement_id`、`operator_id`、`operator_role`、动作、前后状态、说明、创建时间；仅允许追加，不允许更新或删除 |
| `project_requirement_sequences` | `project_id` | `next_sequence`，用于事务内生成项目级需求编号 |

`requirements.project_id` 可为空，其他项目关联记录均采用外键限制删除。已被需求使用的项目版本、已被需求引用的项目和用户均必须拒绝物理删除；如需后台治理，采用 `status` 或 `deleted_at` 软删除。项目重命名不会改写历史需求编号，需求通过 `project_id` 关联项目，不依赖冗余项目名称。

状态动作必须在一个数据库事务内完成：读取并锁定需求记录，校验 `updatedAt`、调用人角色和前置状态，校验版本/Owner/退回原因/终止原因/发布日期，更新需求主记录，并追加一条不可篡改的历史记录。任一步失败均整体回滚。

建议索引：`requirements(project_id, status, updated_at)`、`requirements(requester_owner_id, status)`、`requirements(status, created_at)`、`requirements(code)`、`project_versions(project_id, release_date)`、`requirement_histories(requirement_id, created_at DESC)`；中文关键词搜索使用数据库全文索引或独立搜索服务，不使用前端全量过滤替代。

## 数据迁移

上线前的数据迁移只能从受控的服务端数据库备份、导出文件或经过审查的种子文件执行，不能从浏览器缓存导入。迁移必须：先导入用户和项目，再导入项目版本与需求，最后以时间正序写入历史；重复项目按 `name_normalized` 合并，并将需求和版本外键迁移至保留项目 ID。迁移脚本必须可重复执行、记录结果并具备回退评估，且不得覆盖云端已有生产数据。

## 错误码

`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`VALIDATION_ERROR`、`STATE_CONFLICT`、`VERSION_REQUIRED`、`RELEASE_DATE_REQUIRED`、`TERMINATION_REASON_REQUIRED`、`PROJECT_NAME_CONFLICT`、`PROJECT_REFERENCED`、`PROJECT_VERSION_REFERENCED`、`USER_REFERENCED`。
