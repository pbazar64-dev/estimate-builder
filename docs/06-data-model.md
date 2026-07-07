# 06. Модель данных

## 6.1. ER-диаграмма (текстовая)

```
Country (страна/ставка)
   │ 1
   │
   │ N
Estimate ────────────────< EstimateVersion >──────── (snapshot JSONB)
   │ 1        1        N        │ 1
   │                           │
   │ N                         │ N
DealLink (CRM)          ApprovalRoute ──1──N── ApprovalStep
   │                           │                    │ N
   │                           │                    │
   │                           └──1──N── ApprovalHistory
   │
Stage (справочник этапов) ──используется в── snapshot.stages[]
CatalogItem (каталог) ──копируется в── snapshot.lines[] / шаблоны разделов
CatalogCategory ──1──N── CatalogItem
DocumentTemplate ──используется── GeneratedDocument >──N──1── EstimateVersion
AuditLog ──ссылается на── (любую сущность)
AppUser ──маппинг──> Bitrix24 user + Role
```

Логическая иерархия сметы **внутри версии** хранится как слепок (JSONB):
`Version.snapshot = { stages[], groups[], lines[] }` — денормализовано ради
целостности «замороженной» версии и быстрого diff/восстановления. Активная
(редактируемая) смета также имеет нормализованное «рабочее» дерево (см. 6.3).

---

## 6.2. Основные таблицы

### `country` — страны и ставки
| Поле | Тип | Прим. |
|---|---|---|
| id | uuid PK | |
| name | text | «Россия» |
| currency | text | ISO-код: RUB, KZT, BYN, UZS, PLN |
| hourly_rate | numeric(12,2) | ставка часа |
| is_active | bool | |
| created_at / updated_at | timestamptz | |

### `estimate` — смета (шапка)
| Поле | Тип | Прим. |
|---|---|---|
| id | uuid PK | |
| title | text | название |
| deal_id | bigint | ID сделки Битрикс24 (обяз.) |
| company_id | bigint | ID компании CRM |
| contact_id | bigint | ID контакта CRM |
| responsible_user_id | bigint | ответственный (B24 user) |
| country_id | uuid FK→country | текущая страна расчёта |
| currency | text | текущая валюта |
| status | text enum | draft/on_approval/approved/rejected/kp_ready/contract_ready/signed/archived |
| current_version_id | uuid FK→estimate_version | |
| total_amount | numeric(14,2) | кэш суммы текущей версии |
| margin | numeric(5,4) | кэш маржи |
| is_archived | bool | |
| created_by / updated_by | bigint | |
| created_at / updated_at | timestamptz | |

### `estimate_version` — версия сметы (слепок)
| Поле | Тип | Прим. |
|---|---|---|
| id | uuid PK | |
| estimate_id | uuid FK→estimate | |
| number | int | автоинкремент в рамках сметы |
| author_id | bigint | |
| comment | text | комментарий к версии |
| currency | text | зафиксированная валюта |
| country_id | uuid | зафиксированная страна |
| hourly_rate | numeric(12,2) | **зафиксированная ставка (снапшот)** |
| total_amount | numeric(14,2) | сумма версии |
| total_cost | numeric(14,2) | себестоимость (по часам исполнителя) |
| margin | numeric(5,4) | маржа версии |
| duration_days | int | срок реализации |
| snapshot | jsonb | полный слепок дерева + этапов + платежей |
| created_at | timestamptz | |

`snapshot` (структура):
```jsonc
{
  "stages": [ { "code": "modeling", "title": "Моделирование",
                "enabled": true, "order": 1 } ],
  "lines": [
    { "id": "l1", "stage": "setup", "level": 2, "path": "2.3",
      "parentId": "g_crm", "name": "СРМ", "description": "...",
      "qty": null, "hoursExecutor": 0, "hoursClient": 0,
      "unitPrice": 0, "amount": 0, "isGroup": true },
    { "id": "l2", "stage": "setup", "level": 3, "path": "2.3.1",
      "parentId": "l1", "name": "Настройка воронок",
      "description": "...", "qty": 1, "hoursExecutor": 1,
      "hoursClient": 1, "unitPrice": 200, "amount": 200 }
  ],
  "payments": [
    { "no": 1, "name": "Аванс", "amount": 9700,
      "term": "3 банковских дня с момента подписания", "date": "2026-04-01" }
  ],
  "totals": { "amount": 19400, "hoursExecutor": 68, "hoursClient": 95 }
}
```

### `stage` — справочник этапов проекта
| Поле | Тип | Прим. |
|---|---|---|
| id | uuid PK | |
| code | text | modeling / setup / trial / preresearch / development |
| title | text | |
| enabled_by_default | bool | modeling/setup/trial = true |
| default_order | int | |

### `catalog_category` / `catalog_item` — каталог типовых работ
`catalog_item`: `id, category_id FK, name, description_template, hours_executor,
hours_client, base_rate, default_executor_role, is_active`.

### `approval_route` / `approval_step` — маршруты согласования
`approval_route`: `id, estimate_id, version_id, mode(sequential|parallel), status`.
`approval_step`: `id, route_id, order, role, approver_user_id, decision(pending|
approved|rejected|rework), comment, decided_at`.

### `approval_history` — история согласований
`id, estimate_id, version_id, actor_id, action, comment, created_at`.

### `document_template` / `generated_document`
`document_template`: `id, type(kp|contract|specification), name, file_path,
variables jsonb, is_default`.
`generated_document`: `id, version_id, template_id, type, format(docx|pdf),
file_path, created_by, created_at`.

### `section_template` — шаблоны разделов сметы
`id, name, owner_id, payload jsonb (поддерево строк), created_at`.

### `app_user` / `role`
`app_user`: `id, b24_user_id, role, department, is_active`.
`role`: enum `company_head | project_manager | sales_manager | analyst`.

### `audit_log`
`id, actor_id, entity_type, entity_id, action, diff jsonb, ip, created_at`.

---

## 6.3. Рабочее дерево vs. слепок

- **Черновик** редактируется в нормализованном виде (`estimate_line` — рабочая
  таблица строк текущего черновика) для быстрых частичных апдейтов и autosave.
- При **сохранении версии** рабочее дерево сериализуется в `estimate_version.
  snapshot` (иммутабельный слепок).
- Diff версий — сравнение двух `snapshot` по `line.id`/`path`.

`estimate_line` (рабочая): `id, estimate_id, stage, level, order, parent_id,
name, description, qty, hours_executor, hours_client, unit_price, amount,
is_group, catalog_item_id NULL`.

---

## 6.4. Индексы (производительность)

```sql
-- Реестр: фильтры/сортировки
CREATE INDEX idx_estimate_status        ON estimate(status) WHERE is_archived = false;
CREATE INDEX idx_estimate_responsible   ON estimate(responsible_user_id);
CREATE INDEX idx_estimate_deal          ON estimate(deal_id);
CREATE INDEX idx_estimate_company       ON estimate(company_id);
CREATE INDEX idx_estimate_updated_at    ON estimate(updated_at DESC);
-- Полнотекстовый поиск по названию/компании
CREATE INDEX idx_estimate_title_trgm    ON estimate USING gin (title gin_trgm_ops);
-- Версии
CREATE INDEX idx_version_estimate       ON estimate_version(estimate_id, number DESC);
CREATE INDEX idx_version_snapshot_gin   ON estimate_version USING gin (snapshot jsonb_path_ops);
-- Рабочие строки
CREATE INDEX idx_line_estimate_order    ON estimate_line(estimate_id, "order");
CREATE INDEX idx_line_parent            ON estimate_line(parent_id);
-- Согласование
CREATE INDEX idx_approval_step_route    ON approval_step(route_id, "order");
CREATE INDEX idx_approval_hist_estimate ON approval_history(estimate_id, created_at DESC);
-- Каталог
CREATE INDEX idx_catalog_category       ON catalog_item(category_id) WHERE is_active;
CREATE INDEX idx_catalog_name_trgm      ON catalog_item USING gin (name gin_trgm_ops);
-- Аудит
CREATE INDEX idx_audit_entity           ON audit_log(entity_type, entity_id, created_at DESC);
```

---

## 6.5. Целостность и правила

- `estimate.deal_id` — **NOT NULL** (обязательная связь со сделкой).
- Каскад: удаление сметы → мягкое (архив); физически версии не удаляются.
- `estimate_version` — **иммутабельна** после создания (append-only).
- Сумма/маржа сметы = кэш из `current_version`; пересчёт — на бэкенде
  (CalcEngine), клиент лишь предвычисляет для UX.
- Валюта/ставка версии фиксируются в момент сохранения (историческая точность).
