# 07. API

REST API (JSON) между SPA и бэкендом. База: `/api/v1`. Аутентификация — сессия
приложения (JWT), выпущенная после OAuth-хэндшейка с Битрикс24. Все мутирующие
методы проверяют роль (RBAC) и владение.

## 7.1. Соглашения
- Формат: `application/json`, UTF-8.
- Ошибки: `{ "error": { "code", "message", "details" } }`, коды HTTP
  400/401/403/404/409/422/500.
- Пагинация: `?page=&pageSize=` → `{ items, total, page, pageSize }`.
- Идемпотентность генерации: `Idempotency-Key` для POST документов.

## 7.2. Аутентификация / контекст
| Метод | Назначение |
|---|---|
| `POST /auth/b24/callback` | OAuth callback, обмен кода на токен, выпуск сессии |
| `GET /auth/me` | Текущий пользователь + роль + права |
| `POST /auth/refresh` | Обновление сессии |

## 7.3. Сметы
| Метод | Назначение |
|---|---|
| `GET /estimates` | Реестр (фильтры: `status, responsible, dealId, companyId, country, dateFrom/To, q, archived`; сортировка `sort=field:asc`) |
| `POST /estimates` | Создать смету (мастер: `dealId, countryId, currency, title`) |
| `GET /estimates/{id}` | Карточка сметы (инфоблок + список версий) |
| `PATCH /estimates/{id}` | Изменить шапку (ответственный, название) |
| `POST /estimates/{id}/archive` / `/restore` | Архив/восстановление |
| `DELETE /estimates/{id}` | Мягкое удаление (только Рук. компании) |

## 7.4. Черновик / редактор
| Метод | Назначение |
|---|---|
| `GET /estimates/{id}/draft` | Текущее рабочее дерево (строки + этапы) |
| `PUT /estimates/{id}/draft` | Полное сохранение черновика (autosave) |
| `PATCH /estimates/{id}/draft/lines` | Пакет операций над строками (add/update/delete/move/reindent/duplicate) |
| `POST /estimates/{id}/draft/from-catalog` | Вставить позиции из каталога (`catalogItemIds[]`, `parentId`) |
| `POST /estimates/{id}/draft/recalc` | Пересчёт на сервере (источник истины) |
| `PATCH /estimates/{id}/stages` | Вкл/выкл/порядок этапов |

## 7.5. Версии
| Метод | Назначение |
|---|---|
| `POST /estimates/{id}/versions` | Сохранить версию (`comment`) → слепок |
| `GET /estimates/{id}/versions` | Список версий |
| `GET /versions/{versionId}` | Просмотр версии (слепок) |
| `POST /versions/{versionId}/restore` | Откат: создать новую версию-копию |
| `GET /versions/diff?from=&to=` | Diff двух версий (added/removed/changed) |
| `GET /versions/{versionId}/excel` | Выгрузка Excel |

## 7.6. Согласование
| Метод | Назначение |
|---|---|
| `POST /versions/{versionId}/approval` | Запуск согласования (по маршруту) |
| `GET /estimates/{id}/approval` | Текущий маршрут + шаги + история |
| `POST /approval/steps/{stepId}/decision` | Решение: `approve/reject/rework` + `comment` |

## 7.7. Генерация документов
| Метод | Назначение |
|---|---|
| `POST /versions/{versionId}/documents` | Сгенерировать (`type: kp|contract|specification`, `format: docx|pdf`, `templateId?`) → задача в очереди |
| `GET /documents/{docId}` | Статус/ссылка на файл |
| `GET /documents/{docId}/download` | Скачать |

## 7.8. Каталог / справочники
| Метод | Назначение |
|---|---|
| `GET /catalog?categoryId=&q=` | Позиции каталога |
| `POST/PATCH/DELETE /catalog/{id}` | CRUD (рук. проектов/компании) |
| `GET /catalog/categories` | Категории |
| `GET/POST/PATCH/DELETE /countries` | Страны и ставки (настройки) |
| `GET/POST/PATCH/DELETE /stages` | Этапы (настройки) |
| `GET/POST/PATCH/DELETE /approval-routes` | Маршруты (настройки) |
| `GET/POST/PATCH/DELETE /templates` | Шаблоны документов (настройки) |
| `GET/POST/DELETE /section-templates` | Шаблоны разделов сметы |

## 7.9. Аналитика / CRM
| Метод | Назначение |
|---|---|
| `GET /analytics/overview` | Сводка (статусы, ср. сумма, скорость согл.) |
| `GET /analytics/services-top` | Топ услуг |
| `GET /analytics/timeline` | Динамика по месяцам |
| `GET /crm/deals/{dealId}/estimates` | Сметы по сделке (для виджета) |

## 7.10. DTO (примеры)

```ts
// Создание сметы
interface CreateEstimateDto {
  title: string; dealId: number; countryId: string; currency: string;
}
// Строка сметы
interface EstimateLineDto {
  id: string; stage: string; level: 1|2|3; parentId: string|null;
  name: string; description?: string; qty?: number;
  hoursExecutor?: number; hoursClient?: number;
  unitPrice: number; amount: number; isGroup: boolean;
  catalogItemId?: string|null;
}
// Итоги пересчёта
interface RecalcResultDto {
  totalAmount: number; durationDays: number;
  stageTotals: { stage: string; amount: number; hoursClient: number }[];
}
// Решение согласования
interface ApprovalDecisionDto { decision: 'approve'|'reject'|'rework'; comment?: string; }
```

## 7.11. События / вебхуки
- **Исходящие вебхуки** (для внешних систем/1С в будущем):
  `estimate.approved`, `estimate.signed`, `document.generated`,
  `version.created` — конфигурируемые endpoint + HMAC-подпись.
- **Входящие от Битрикс24**: `ONCRMDEALUPDATE` (синхронизация сделки),
  `ONAPPUNINSTALL` (очистка).
- **Внутренние доменные события** (шина): используются для аудита,
  уведомлений и пересчёта аналитики.
