---
description: Собрать данные задачи EUTP из YouTrack и провести первичный анализ реализации по кодовой базе
argument-hint: "<ссылка-на-задачу> [pora_session] [additional_info]"
---
Ты выполняешь первичный анализ задачи EUTP по кодовой базе, в которой запущен.
Работай строго по шагам. После каждого шага сообщи результат кратко, без воды.

## Входные данные

Ссылка на задачу: $1
PORA session из аргумента: $2
Дополнительная информация: $3

Правила аргументов:
- `$1` — обязательная ссылка на задачу.
- `$2` — опциональное значение куки `pora-gatekeeper-session`.
- `$3` — опциональная дополнительная информация к задаче; учитывай её при анализе и в плане.
- Если вызов выглядит как `/analyze-eutp {ссылка} '' {дополнительная информация}`, считай `$2` пустым: НЕ записывай его в `~/.zshrc`, используй `PORA_SESSION` из текущего окружения, а `$3` используй как дополнительную информацию.

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

**Важно:** этот endpoint требует сессионную куку `pora-gatekeeper-session`.

Перед запросом выбери session так:
1. Если `$2` не пустой и не равен `''`, используй его вместо env: экспортируй в текущей сессии и сохрани в `~/.zshrc`.
2. Если `$2` пустой или равен `''`, используй существующий `PORA_SESSION` из окружения.
3. Если итоговый `PORA_SESSION` пустой — скажи об этом, но НЕ останавливайся, переходи к шагу 2b.

Минимальная команда для случая, когда `$2` передан:

```bash
export PORA_SESSION='$2'
python3 << 'PYEOF'
from pathlib import Path
import os, re
zshrc = Path.home() / '.zshrc'
value = os.environ['PORA_SESSION']
line = "export PORA_SESSION='" + value.replace("'", "'\\''") + "'"
text = zshrc.read_text() if zshrc.exists() else ''
if re.search(r'^export PORA_SESSION=.*$', text, flags=re.M):
    text = re.sub(r'^export PORA_SESSION=.*$', line, text, flags=re.M)
else:
    text = text.rstrip() + ('\n' if text else '') + line + '\n'
zshrc.write_text(text)
PYEOF
```

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
Если `$3` передан — отдельным блоком выведи **Дополнительную информацию пользователя**.

## Шаг 4 — Проанализируй кодовую базу

На основе заголовка, описания задачи и `$3` (если передан) определи **затронутые зоны** в текущем репозитории.
Для этого:

1. **Выдели ключевые термины** из описания (русские и английские): названия фич, типов сообщений, форматов, API-методов, компонентов.
2. **Найди файлы** через `grep`/`ffgrep` по этим терминам. Минимум 3 поисковых запроса разными словами.
3. **Прочитай** 3–5 наиболее релевантных файлов (заголовки экспортов, сигнатуры, ключевую логику).
4. **Найди аналогичные реализации** — если задача похожа на уже существующую фичу, покажи где и как сделано.

## Шаг 5 — Выдай план анализа

Выведи:

```md
## Понимание задачи
(2–3 предложения своими словами, учитывая дополнительную информацию пользователя, если она передана)

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

`PORA_SESSION` — обязательна для получения реального описания. Её можно передать вторым аргументом prompt; тогда prompt должен записать её в `~/.zshrc` и использовать сразу в текущей сессии.
`EUTP_TOKEN` — опциональна, используется как фолбэк если нет сессии.

Куку `pora-gatekeeper-session` брать в DevTools → Application → Cookies → `urs.esoft.tech`.
