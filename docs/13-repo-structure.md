# 13. Структура репозитория (целевая)

Монорепозиторий (frontend + backend + docs). Приведена целевая структура для
этапа реализации (сейчас в репозитории — документация и прототипы).

```
estimate-builder/
├── README.md
├── docs/                          # ТЗ и архитектурная документация (этот раздел)
├── prototypes/                    # HTML-прототипы UI (Vogue) + PNG
│   ├── index.html
│   └── img/
│
├── apps/
│   ├── web/                       # Frontend (React + TS + Vite)
│   │   ├── src/
│   │   │   ├── app/               # роутинг, провайдеры, BX24-инициализация
│   │   │   ├── features/          # реестр, карточка, конструктор, diff,
│   │   │   │                      #   каталог, согласование, мастер, настройки
│   │   │   ├── entities/          # доменные модели (estimate, version, ...)
│   │   │   ├── shared/            # UI-kit «Vogue», хуки, api-клиент, calc-engine
│   │   │   └── widgets/           # виджет сделки CRM (placement)
│   │   ├── public/
│   │   ├── index.html
│   │   └── vite.config.ts
│   │
│   └── api/                       # Backend (NestJS)
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/          # OAuth B24, сессии, RBAC guards
│       │   │   ├── estimates/     # CRUD, черновик, реестр
│       │   │   ├── versions/      # версии, слепки, diff, откат
│       │   │   ├── calc/          # CalcEngine (формулы, итоги, маржа)
│       │   │   ├── catalog/       # каталог типовых работ
│       │   │   ├── approval/      # маршруты, шаги, история
│       │   │   ├── documents/     # генерация DOCX/PDF/XLSX
│       │   │   ├── settings/      # страны/ставки, этапы, шаблоны, маршруты
│       │   │   ├── analytics/     # отчёты/дашборды
│       │   │   ├── b24/           # интеграция REST/вебхуки Битрикс24
│       │   │   └── audit/         # аудит-лог
│       │   ├── common/            # DTO, фильтры, интерсепторы, guards
│       │   └── main.ts
│       └── test/
│
├── packages/
│   ├── shared-types/              # общие TS-типы/DTO (web + api)
│   └── calc-core/                 # изоморфный движок расчёта (web + api)
│
├── db/
│   ├── migrations/                # миграции БД (напр. Prisma/TypeORM)
│   └── seeds/                     # стартовый каталог, страны/ставки, этапы
│
├── templates/                     # шаблоны документов (КП/договор/спецификация)
│
├── infra/
│   ├── docker/                    # Dockerfile'ы (web, api, worker)
│   ├── docker-compose.yml         # локальный стенд (api, db, redis, worker)
│   └── nginx/                     # reverse proxy / TLS
│
├── tests/
│   ├── e2e/                       # сквозные сценарии (Playwright)
│   └── load/                      # нагрузочные (большие сметы)
│
├── .github/workflows/             # CI (lint, test, build, deploy)
├── .env.example
├── package.json                   # workspaces (pnpm/turbo)
└── tsconfig.base.json
```

## Ключевые решения
- **Монорепо** с общими пакетами `shared-types` и `calc-core` — единый расчёт и
  типы на фронте и бэке (нет рассинхрона формул).
- **Миграции + сиды** — воспроизводимая БД со стартовым каталогом/ставками.
- **`templates/`** — версионируемые шаблоны документов «Ава Тетис».
- **`infra/`** — воспроизводимое развёртывание (см. `docs/05-architecture.md` §5.6).
