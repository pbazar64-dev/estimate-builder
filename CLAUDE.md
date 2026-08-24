# Estimate Builder — конструктор смет (Битрикс24 · VibeCode)

Паспорт проекта и контекст для Claude Code. Прочитай целиком перед изменениями.
Подробности продукта и деплоя — в [`app/README.md`](app/README.md).

## Что это

Node.js-приложение «Конструктор смет» для Битрикс24 **без внешних зависимостей**
(встроенный `http`, порт 3000). Реестр смет, мастер создания, конструктор с живым
пересчётом, версии, каталог типовых работ, настройки стран/ставок, генерация КП и
Спецификации, и **«Запустить проект»** (создаёт смарт-процесс «Спецификации» + группу
+ задачи). Маржинальность НЕ считается (по требованию заказчика).

Портал: **avrika.bitrix24.ru**. Данные смет — в `store.json` (см. «Хранение данных»).

## Структура

```
app/
├── server.js   # HTTP-сервер: статика + REST API /api/*, интеграция с Битрикс24
├── calc.js     # движок расчёта (формулы, итоги; без маржи)
├── seed.js     # стартовые данные (страны, каталог, демо-сметы)
├── kp.js       # печатные формы КП/Спецификации
├── package.json
└── public/     # SPA: index.html, app.js, styles.css
```

## Локальный запуск и тесты

```bash
cd app && node --check server.js
VIBE_API_KEY=vibe_api_xxx node server.js   # → http://localhost:3000
```
Внешних зависимостей нет. Тестового раннера в репозитории нет — проверяй `node --check`
и вручную по сценариям.

## Ветка разработки

Разрабатывай на **`claude/bitrix24-estimates-proposals-ulwcvd`**, коммить и пушь туда же.
PR не создавай без явной просьбы.

## Аутентификация

- `server.js` ходит в Битрикс24 через обёртку VibeCode заголовком `X-Api-Key: <VIBE_API_KEY>`
  **без Bearer** — то есть это **personal-ключ** `vibe_api_*` (проверка `CRM_LIVE = /^vibe_api_/`).
  Такой ключ читает/пишет CRM портала без пользовательской сессии (headless).
- Запускающего проект пользователя берём из шлюза (BFF), иначе — владелец ключа.

## Деплой на VibeCode (рецепт)

Не секретные идентификаторы:

| Что | Значение |
|-----|----------|
| APP_ID | `966a4250-220a-4eb9-82b1-111ab336a35e` (приложение «Конструктор смет») |
| SERVER_ID | `70231cf3-7f37-4b49-98f5-3b307187ce50` (сервер konstruktor-smet) |
| APP_URL | `https://app-b0f7edb57b61.vibecode.bitrix24.tech` |
| API base | `https://vibecode.bitrix24.tech/v1` |

**Секреты (в репозиторий НЕ коммить, владелец передаёт в env/сообщении):**
- `APP_KEY` — ключ приложения `vibe_app_*` для хранилища кода и деплоя.
- `VIBE_API_KEY` — personal-ключ `vibe_api_*` для чтения/записи CRM в рантайме.
- `EB_ADMIN_TOKEN` — токен для backup/restore данных.

Деплой идёт через **хранилище кода** (source storage → versionId), а не base64. Правила:

```bash
export APP_KEY="<vibe_app_*>"; export VIBE_API_KEY="<vibe_api_*>"; export EB_ADMIN_TOKEN="<токен>"
APP_ID=966a4250-220a-4eb9-82b1-111ab336a35e
SID=70231cf3-7f37-4b49-98f5-3b307187ce50
API=https://vibecode.bitrix24.tech

tar czf /tmp/app.tar.gz -C app --exclude=data --exclude=node_modules .
VER=$(curl -s -X POST "$API/v1/apps/$APP_ID/sources" -H "X-Api-Key: $APP_KEY" \
  -H "Content-Type: application/gzip" -H "X-Tags: manual" --data-binary @/tmp/app.tar.gz \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['versionId'])")
curl -s -X POST "$API/v1/infra/servers/$SID/deploy?stream=false" -H "X-Api-Key: $APP_KEY" \
  -H "Content-Type: application/json" -d "{
    \"source\": {\"versionId\": \"$VER\"},
    \"install\": \"mkdir -p /var/lib/estimate-builder && chown 999:988 /var/lib/estimate-builder && chmod 755 /var/lib/estimate-builder\",
    \"start\": \"node server.js\", \"port\": 3000,
    \"env\": {\"NODE_ENV\":\"production\",\"VIBE_API_KEY\":\"$VIBE_API_KEY\",\"EB_DATA_DIR\":\"/var/lib/estimate-builder\",\"EB_ADMIN_TOKEN\":\"$EB_ADMIN_TOKEN\"}
  }"
```

**Грабли деплоя (обязательно!):**
- **НЕ передавай `runtime`** — node уже стоит на сервере; шаг `runtime` пытается ставить
  node с deb.nodesource.com и падает.
- **Всегда передавай `install`-хук и `EB_DATA_DIR`** из примера. Шаг `clean` затирает
  `/opt/app` целиком, поэтому данные смет ОБЯЗАНЫ лежать вне `/opt/app`, в
  `/var/lib/estimate-builder` (создаётся в `install`, владелец — `vibeapp` uid 999/gid 988,
  переживает деплой и перезагрузку).
- **Передавай те же env при КАЖДОМ деплое** — иначе `EB_ADMIN_TOKEN`/каталог данных сбросятся.

## Backup / restore данных (откат состояния)

```bash
# нужен api-bearer токен шлюза: POST $API/v1/infra/servers/$SID/access-tokens {"mode":"api-bearer"}
curl -H "Authorization: Bearer <api-bearer>" \
  "$APP_URL/api/admin/backup?token=$EB_ADMIN_TOKEN" -o store-backup.json
curl -X POST -H "Content-Type: application/json" \
  "$APP_URL/api/admin/restore?token=$EB_ADMIN_TOKEN" --data-binary @store-backup.json
```

## «Запустить проект» — смарт-процесс «Спецификации» (грабли — читай!)

Логика в `launchProject()` (`app/server.js`). Портально-зависимые константы — в объекте
`SPEC` (entityTypeId **1040**, categoryId 29, поля `ufCrm13_*`) и `USERS`
(`polina:259, nastasya:301, andrey:1, sergey:71`), страны — `COUNTRY_ENUM`.

**Привязка задач к элементу смарт-процесса (поле задачи «Элемент CRM», `UF_CRM_TASK`):**
код привязки для смарт-процесса — это `SYMBOL_CODE_SHORT` = префикс `'T'` + entityTypeId
в **ШЕСТНАДЦАТЕРИЧНОМ** виде, а НЕ в десятичном. Для 1040 → `0x410` → **`T410`**.
Реализовано как `'T' + Number(SPEC.entityTypeId).toString(16)`. Десятичное `T1040` Битрикс24
молча игнорирует (значение `UF_CRM_TASK` не сохраняется), и спецификация не прикрепляется.
`UF_CRM_TASK` принимает **массив** кодов (`["T410_<id>"]`); строка молча игнорируется.
Для смарт-процесса должен быть включён `isUseInUserfieldEnabled` у типа.

## Хранение данных (важно!)

`store.json` (сметы, каталог, страны). Каталог выбирается: `EB_DATA_DIR` →
`/var/lib/estimate-builder` → `/tmp/...` → `<app>/data`. Запись атомарна (`.tmp`+`rename`).
Каталог ОБЯЗАН быть вне `/opt/app` (иначе `clean` при деплое стирает данные).

## Как продолжить в новой сессии / другом аккаунте

1. Подключить GitHub-доступ к `pbazar64-dev/estimate-builder`, открыть сессию Claude Code
   на ветке `claude/bitrix24-estimates-proposals-ulwcvd`.
2. В первом сообщении передать секреты: `APP_KEY` (`vibe_app_*`), `VIBE_API_KEY` (`vibe_api_*`),
   `EB_ADMIN_TOKEN`. Остальные идентификаторы — в этом файле.
3. Claude читает `CLAUDE.md`, дальше можно присылать задачи: правь `app/*.js`, деплой по
   рецепту выше (не забудь `install`+`EB_DATA_DIR`, без `runtime`).
