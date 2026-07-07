// Стартовые данные (сиды) для демо-режима. Реальные значения — из документов «Ава Тетис».
'use strict';

const COUNTRIES = [
  { id: 'ru', name: 'Россия', currency: 'RUB', rate: 3000 },
  { id: 'by', name: 'Беларусь', currency: 'BYN', rate: 80 },
  { id: 'kz', name: 'Казахстан', currency: 'KZT', rate: 15000 },
  { id: 'pl', name: 'Польша', currency: 'PLN', rate: 200 },
  { id: 'uz', name: 'Узбекистан', currency: 'UZS', rate: 450000 },
];

const STAGES = [
  { code: 'preresearch', title: 'Предпроектное исследование', defaultOn: false, order: 1 },
  { code: 'modeling', title: 'Моделирование', defaultOn: true, order: 2 },
  { code: 'setup', title: 'Настройка штатного функционала', defaultOn: true, order: 3 },
  { code: 'development', title: 'Разработка', defaultOn: false, order: 4 },
  { code: 'trial', title: 'Введение в ОПЭ', defaultOn: true, order: 5 },
];

const CATALOG = [
  { id: 'c1', category: 'Моделирование', name: 'Онлайн интервью (1 час)', description: 'Проведение рабочих встреч с аналитиком для детализации требований в формате онлайн-встреч.', stage: 'modeling', hoursExecutor: 1, hoursClient: 1 },
  { id: 'c2', category: 'Моделирование', name: 'Написание ТЗ (технического задания)', description: 'Создание детального документа, регламентирующего состав, логику работы и результаты настраиваемых элементов портала.', stage: 'modeling', hoursExecutor: 8, hoursClient: 16 },
  { id: 'c3', category: 'Моделирование', name: 'Написание ЛТ (листа требований)', description: 'Создание документа, регламентирующего состав, логику работы и результаты настраиваемых элементов портала.', stage: 'modeling', hoursExecutor: 4, hoursClient: 8 },
  { id: 'c4', category: 'CRM', name: 'Настройка воронки сделок', description: 'Создание и конфигурация одной воронки сделок: стадии, поля, типы и правила заполнения.', stage: 'setup', hoursExecutor: 1, hoursClient: 1 },
  { id: 'c5', category: 'CRM', name: 'Настройка воронки лидов', description: 'Создание и конфигурация одной воронки лидов: стадии, поля, правила заполнения.', stage: 'setup', hoursExecutor: 1, hoursClient: 1 },
  { id: 'c6', category: 'CRM', name: 'Настройка роботов/триггеров (пакет до 10)', description: 'Создание бизнес-правил для элемента CRM (лид/сделка/смарт-процесс).', stage: 'setup', hoursExecutor: 2, hoursClient: 2 },
  { id: 'c7', category: 'CRM', name: 'Настройка БП для элемента CRM', description: 'Проектирование и настройка визуального бизнес-процесса: условия, ветвления, параллельные действия.', stage: 'setup', hoursExecutor: 5, hoursClient: 8 },
  { id: 'c8', category: 'CRM', name: 'Настройка прав доступа к CRM (до 7 ролей)', description: 'Конфигурация до 7 ролей с разным уровнем доступа: просмотр, создание, редактирование, экспорт.', stage: 'setup', hoursExecutor: 1, hoursClient: 2 },
  { id: 'c9', category: 'CRM', name: 'Настройка смарт-процесса', description: 'Создание смарт-процесса: стадии, поля, связи, базовая логика.', stage: 'setup', hoursExecutor: 1, hoursClient: 2 },
  { id: 'c10', category: 'Интеграции', name: 'Интеграция с телефонией (ВАТС/Б24)', description: 'Подключение облачной телефонии для звонков из CRM, запись, авто-создание сущностей.', stage: 'setup', hoursExecutor: 6, hoursClient: 8 },
  { id: 'c11', category: 'Интеграции', name: 'Подключение общего корпоративного e-mail', description: 'Настройка приёма писем на общий ящик с созданием элементов CRM.', stage: 'setup', hoursExecutor: 1, hoursClient: 1 },
  { id: 'c12', category: 'Интеграции', name: 'Подключение мессенджеров (открытые линии)', description: 'Настройка приёма сообщений из внешнего мессенджера через «Открытые линии».', stage: 'setup', hoursExecutor: 1, hoursClient: 1 },
  { id: 'c13', category: 'Аналитика', name: 'Настройка отчёта в BI-конструкторе', description: 'Создание отчёта в визуальном конструкторе: источники, поля, визуализации, фильтры.', stage: 'setup', hoursExecutor: 3, hoursClient: 4 },
  { id: 'c14', category: 'КЭДО', name: 'Настройка 1 документа КЭДО', description: 'Полная настройка схемы согласования для одного типа документа: шаблон, маршрут, роли, условия.', stage: 'setup', hoursExecutor: 6, hoursClient: 8 },
  { id: 'c15', category: 'ОПЭ', name: 'Тестирование и корректировки настроек', description: 'Комплексное тестирование системы и приёмка работ, реестр корректировок, доработки.', stage: 'trial', hoursExecutor: 6, hoursClient: 8 },
  { id: 'c16', category: 'ОПЭ', name: 'Запись обучающих видео', description: 'Запись кратких видеоинструкций по работе с настроенным функционалом.', stage: 'trial', hoursExecutor: 1, hoursClient: 2 },
  { id: 'c17', category: 'ОПЭ', name: 'Написание Базы знаний', description: 'Создание структурированного справочного раздела с инструкциями для пользователей.', stage: 'trial', hoursExecutor: 6, hoursClient: 8 },
  { id: 'c18', category: 'Управление', name: 'Управление проектом на этапе', description: 'Административное и операционное сопровождение проекта: координация, планирование, отчётность.', stage: 'setup', hoursExecutor: 5, hoursClient: 6 },
];

let uid = 0;
const nid = (p) => `${p}${(++uid).toString(36)}_${Date.now().toString(36)}`;

// Демо-строки для сметы «АО Конаково» (этап «Настройка штатного функционала»)
function konakovoLines() {
  const gCrm = { id: 'ln_crm', stage: 'setup', level: 2, parentId: null, name: 'СРМ', description: 'Группа услуг', qty: null, hoursExecutor: 0, hoursClient: 0, isGroup: true };
  const gInt = { id: 'ln_int', stage: 'setup', level: 2, parentId: null, name: 'Интеграции каналов связи', description: 'Группа услуг', qty: null, hoursExecutor: 0, hoursClient: 0, isGroup: true };
  return [
    gCrm,
    { id: 'ln1', stage: 'setup', level: 3, parentId: 'ln_crm', name: 'Настройка воронки сделок', description: '1 воронка, до 10 полей', qty: 1, hoursExecutor: 1, hoursClient: 1, isGroup: false },
    { id: 'ln2', stage: 'setup', level: 3, parentId: 'ln_crm', name: 'Настройка роботов/триггеров', description: 'пакет до 10 роботов', qty: 1, hoursExecutor: 2, hoursClient: 2, isGroup: false },
    { id: 'ln3', stage: 'setup', level: 3, parentId: 'ln_crm', name: 'Настройка БП для элемента CRM', description: 'Визуальный бизнес-процесс: условия, ветвления.', qty: 1, hoursExecutor: 5, hoursClient: 8, isGroup: false },
    { id: 'ln4', stage: 'setup', level: 3, parentId: 'ln_crm', name: 'Настройка прав доступа к CRM', description: 'до 7 ролей', qty: 1, hoursExecutor: 1, hoursClient: 2, isGroup: false },
    gInt,
    { id: 'ln5', stage: 'setup', level: 3, parentId: 'ln_int', name: 'Интеграция с телефонией', description: 'ВАТС / ип-телефония Б24', qty: 1, hoursExecutor: 6, hoursClient: 8, isGroup: false },
    { id: 'ln6', stage: 'modeling', level: 2, parentId: null, name: 'Написание ЛТ (листа требований)', description: 'Создание документа требований.', qty: 1, hoursExecutor: 4, hoursClient: 8, isGroup: false },
    { id: 'ln7', stage: 'trial', level: 2, parentId: null, name: 'Тестирование и корректировки', description: 'Комплексное тестирование и приёмка.', qty: 1, hoursExecutor: 6, hoursClient: 8, isGroup: false },
  ];
}

function defaultStages() {
  return STAGES.map((s) => ({ code: s.code, on: s.defaultOn, order: s.order }));
}

function seedStore() {
  const now = new Date().toISOString();
  const estimates = [
    {
      id: 'est1042', title: 'Внедрение Битрикс24 — АО Конаково',
      dealId: 7781, company: 'АО «Конаково»', contact: 'Кыдырбаев С. В.',
      responsible: 'С. Горелышев', countryId: 'ru', currency: 'RUB', rate: 3000,
      status: 'on_approval', isArchived: false,
      createdAt: '2026-02-21T09:00:00Z', updatedAt: '2026-03-02T12:41:00Z',
      createdBy: 'С. Горелышев', updatedBy: 'С. Горелышев',
      draft: { stages: defaultStages(), lines: konakovoLines() },
      versions: [
        { number: 1, author: 'С. Горелышев', comment: 'Первичная смета из каталога', currency: 'RUB', rate: 3000, totalAmount: 84000, durationDays: 22, createdAt: '2026-02-21T09:00:00Z', snapshot: null },
        { number: 2, author: 'С. Горелышев', comment: 'Скорректирована телефония, убрана SMS-рассылка', currency: 'RUB', rate: 3000, totalAmount: 96000, durationDays: 24, createdAt: '2026-02-26T10:00:00Z', snapshot: null },
        { number: 3, author: 'С. Горелышев', comment: 'Добавлен этап «Разработка», уточнены часы CRM', currency: 'RUB', rate: 3000, totalAmount: 120000, durationDays: 28, createdAt: '2026-03-02T12:41:00Z', snapshot: null },
      ],
    },
    {
      id: 'est1035', title: 'Портал под ключ — Nordwind LLP',
      dealId: 7654, company: 'Nordwind LLP', contact: 'A. Serikova',
      responsible: 'С. Горелышев', countryId: 'kz', currency: 'KZT', rate: 15000,
      status: 'approved', isArchived: false,
      createdAt: '2026-06-10T09:00:00Z', updatedAt: '2026-06-14T15:00:00Z',
      createdBy: 'С. Горелышев', updatedBy: 'С. Горелышев',
      draft: { stages: defaultStages(), lines: [] },
      versions: [
        { number: 1, author: 'С. Горелышев', comment: 'Первичная смета', currency: 'KZT', rate: 15000, totalAmount: 2100000, durationDays: 30, createdAt: '2026-06-10T09:00:00Z', snapshot: null },
        { number: 2, author: 'С. Горелышев', comment: 'Добавлено обучение', currency: 'KZT', rate: 15000, totalAmount: 2350000, durationDays: 34, createdAt: '2026-06-14T15:00:00Z', snapshot: null },
      ],
    },
    {
      id: 'est1031', title: 'CRM + телефония — Wisła Sp. z o.o.',
      dealId: 7620, company: 'Wisła Sp. z o.o.', contact: 'M. Nowak',
      responsible: 'М. Ковальская', countryId: 'pl', currency: 'PLN', rate: 200,
      status: 'draft', isArchived: false,
      createdAt: '2026-06-21T09:00:00Z', updatedAt: '2026-06-21T09:00:00Z',
      createdBy: 'М. Ковальская', updatedBy: 'М. Ковальская',
      draft: { stages: defaultStages(), lines: [] },
      versions: [],
    },
  ];
  return { countries: [...COUNTRIES], stages: [...STAGES], catalog: [...CATALOG], estimates };
}


// Демо-данные CRM (используются, когда нет personal-ключа vibe_api_* для чтения портала)
const DEMO_COMPANIES = [
  { id: 1, title: 'АО «Конаково»' },
  { id: 2, title: 'ООО «Прометей Групп»' },
  { id: 3, title: 'Nordwind LLP' },
  { id: 4, title: 'Wisła Sp. z o.o.' },
  { id: 5, title: 'ООО «БелАгроТрейд»' },
  { id: 6, title: 'АО «Гефест»' },
];
const DEMO_DEALS = {
  1: [{ id: 7781, title: 'Внедрение Битрикс24' }, { id: 7782, title: 'Доработка CRM' }],
  2: [{ id: 7650, title: 'Спецификация №9' }, { id: 7651, title: 'Поддержка портала' }],
  3: [{ id: 7654, title: 'Портал под ключ' }],
  4: [{ id: 7620, title: 'CRM + телефония' }],
  5: [{ id: 7599, title: 'Аудит портала' }],
  6: [{ id: 7570, title: 'Разработка смарт-процессов' }],
};

module.exports = { COUNTRIES, STAGES, CATALOG, DEMO_COMPANIES, DEMO_DEALS, seedStore, defaultStages, nid };
