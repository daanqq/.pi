---
description: Собрать данные задачи EUTP из YouTrack и провести первичный анализ реализации по кодовой базе
argument-hint: "<ссылка-на-задачу>"
---
Ты выполняешь первичный анализ задачи EUTP по кодовой базе, в которой запущен.
Работай строго по шагам. После каждого шага сообщи результат кратко, без воды.

## Входные данные

Ссылка на задачу: $1

## Шаг 1 — Извлеки ID задачи

Из ссылки $1 вытащи ID задачи (например `EUTP-145771`).
Поддерживаются оба домена: `urs.esoft.tech/issue/EUTP-...` и `youtrack.esoft.tech/issue/EUTP-...`.
Если ссылка не содержит `EUTP-` — скажи об этом и остановись.

## Шаг 2 — Скачай данные задачи

Используй **два источника**, оба через curl с `--compressed`. Порядок важен.

### 2a. Hub v1 API — реальное описание (приоритетный)

```bash
curl -s --compressed \
  -H "Cookie: pora-gatekeeper-session=$PORA_SESSION" \
  -H "Accept: application/json" \
  "https://urs.esoft.tech/api/user/youtrack/v1/issues/{ID}"
```

Сохрани в `/tmp/eutp-{ID}.json`.

**Важно:** этот endpoint требует сессионную куку `pora-gatekeeper-session`. Переменная окружения `PORA_SESSION` должна быть установлена у пользователя. Если переменная не установлена — скажи об этом, но НЕ останавливайся, переходи к шагу 2b.

Из ответа извлеки и покажи поля этим скриптом:

```bash
python3 << 'PYEOF'
import json
with open('/tmp/eutp-{ID}.json') as f:
    data = json.load(f)

def get(obj, *keys, default='—'):
    for k in keys:
        obj = obj.get(k, {}) if isinstance(obj, dict) else default
    return obj if obj not in (None, '', []) else default

for k in ['id','title','state','priority','layer','class','type','estimation','spentTimeMinutes']:
    print(f'{k}: {data.get(k, "—")}')

a = data.get('assignee', {})
print(f'assignee.fullName: {a.get("fullName", "—")}')

sprints = data.get('sprints', [])
print(f'sprints[0].name: {sprints[0].get("name", "—") if sprints else "—"}')

teams = data.get('teams', [])
print(f'teams[0].name: {teams[0].get("name", "—") if teams else "—"}')

links = data.get('links', {})
for k in ['parent','childrens','related','epics','works','stages']:
    print(f'links.{k}: {links.get(k, "—")}')

md = data.get('textMd', '')
print(f'textMd length: {len(md)} chars')
print()
print(md[:3000])
PYEOF
```

Извлечённые поля:
- `textMd` — **основное описание задачи** (Markdown)
- `title` — заголовок
- `state`, `priority`, `layer`, `class`, `type`
- `assignee.fullName`
- `sprints[0].name`
- `estimation`, `spentTimeMinutes`
- `teams[0].name`
- `links.parent`, `links.childrens`, `links.related`, `links.epics`, `links.works`, `links.stages`

### 2b. Стандартный REST API — метаданные (фолбэк)

Если шаг 2a не сработал (нет `PORA_SESSION` или пустой ответ), запроси стандартный API:

```bash
curl -s --compressed \
  -H "Authorization: Bearer $EUTP_TOKEN" \
  -H "Accept: application/json" \
  "https://urs.esoft.tech/api/issues/{ID}?fields=idReadable,summary,description,created,updated,customFields(name,value(name,presentation,text)),comments(text,author(fullName),created),links(linkType(name),issues(idReadable,summary))"
```

Извлеки те же поля, что и в 2a, но учти: `description` здесь обычно содержит заглушку, а не реальное описание. Custom fields дают `State`, `Assignee`, `Priority`, `Спринт`, `Estimation Time`, `Spent time`.

### 2c. Комментарии и активности

Если нужны комментарии — они есть в обоих API (в v1 — `comments`, в стандартном — `comments`).
Если нужно увидеть историю изменений описания — стандартный API:

```bash
curl -s --compressed \
  -H "Authorization: Bearer $EUTP_TOKEN" \
  -H "Accept: application/json" \
  "https://urs.esoft.tech/api/issues/{ID}/activities?categories=DescriptionCategory,CommentsCategory,SummaryCategory&fields=id,timestamp,author(fullName),added,removed,text"
```

## Шаг 3 — Покажи сводку задачи

Выведи в компактной таблице:

| Поле | Значение |
|------|----------|
| ID | ... |
| Заголовок | ... |
| Статус | ... |
| Исполнитель | ... |
| Приоритет | ... |
| Слой / Класс | ... |
| Спринт | ... |
| Оценка / Затрачено | ... |

Затем выведи **полный текст описания** (из `textMd` если есть, иначе из `description`).

## Шаг 4 — Проанализируй кодовую базу

На основе заголовка и описания задачи определи **затронутые зоны** в текущем репозитории.
Для этого:

1. **Выдели ключевые термины** из описания (русские и английские): названия фич, типов сообщений, форматов, API-методов, компонентов.
2. **Найди файлы** через `grep`/`ffgrep` по этим терминам. Минимум 3 поисковых запроса разными словами.
3. **Прочитай** 3–5 наиболее релевантных файлов (заголовки экспортов, сигнатуры, ключевую логику).
4. **Найди аналогичные реализации** — если задача похожа на уже существующую фичу, покажи где и как сделано.

## Шаг 5 — Выдай план анализа

Выведи:

```md
## Понимание задачи
(2–3 предложения своими словами)

## Затронутые файлы
- `path/to/file.ts` — почему затронут
- ...

## Похожие реализации
- `path/to/similar.ts` — что можно переиспользовать

## Предварительный план изменений
1. ...
2. ...

## Риски и вопросы
- ...
```

**Важно:** это ПЕРВИЧНЫЙ анализ, а не реализация. Не пиши код. Не делай изменений.
Только собери информацию и предложи план.

## Переменные окружения (пользователь должен настроить)

```bash
export PORA_SESSION="<значение куки pora-gatekeeper-session из браузера>"
export EUTP_TOKEN="perm:<permanent-token из YouTrack>"  # опционально, фолбэк
```

`PORA_SESSION` — обязательна для получения реального описания.
`EUTP_TOKEN` — опциональна, используется как фолбэк если нет сессии.

Куку `pora-gatekeeper-session` брать в DevTools → Application → Cookies → `urs.esoft.tech`.
