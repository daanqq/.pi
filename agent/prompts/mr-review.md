---
description: Review GitLab merge requests using thermo-nuclear code quality standard
argument-hint: "<MR-URL> [MR-URL...]"
---
Проведи ревью GitLab merge request-ов $@ в воркспейсе `/home/user/echat/reviews`.

## Правила

- Каждый MR URL: `https://git.esoft.tech/tidy/<repo>/-/merge_requests/<iid>` → локальный репо `./<repo>`.
- Перед ревью загрузи скилл thermo-nuclear-code-quality-review и применяй его.
- Не перезаписывай локальные изменения. Фетчи MR в ветку `mr-<iid>`.
- Если GitLab требует авторизации в браузере — скажи и продолжай через git.
- Отвечай на русском.

## Workflow

### 0. Извлечение задачи из MR

До начала ревью, для каждого MR найди связанную задачу EUTP:

1. **Найди ссылку на задачу** — проверь три источника (в порядке приоритета):
   - Коммит-сообщение MR: `git log mr-<iid> --not origin/master --format=%B`
   - Заголовок MR из GitLab API: `curl -s --compressed -H "Private-Token: $GITLAB_TOKEN" "https://git.esoft.tech/api/v4/projects/tidy%2F<repo>/merge_requests/<iid>" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title','')); print('---'); print(d.get('description',''))"`
   - Если GitLab API недоступен (нет `$GITLAB_TOKEN`) — только коммит-сообщение.

2. **Извлеки ID задачи** — ищи `EUTP-XXXXX` в заголовке/описании MR. Поддерживаются ссылки с доменов `urs.esoft.tech` и `youtrack.esoft.tech`.

3. **Скачай задачу через Hub v1 API**:
   ```bash
   curl -s --compressed \
     -H "Cookie: pora-gatekeeper-session=$PORA_SESSION" \
     -H "Accept: application/json" \
     "https://urs.esoft.tech/api/user/youtrack/v1/issues/{ID}" \
     -o /tmp/eutp-{ID}.json
   ```
   Если `$PORA_SESSION` не установлена — скажи об этом и продолжай без задачи.

4. **Извлеки данные задачи** скриптом:
   ```bash
   python3 << 'PYEOF'
   import json
   with open('/tmp/eutp-{ID}.json') as f:
       data = json.load(f)
   def get(obj, *keys, default='—'):
       for k in keys:
           obj = obj.get(k, {}) if isinstance(obj, dict) else default
       return obj if obj not in (None, '', []) else default
   for k in ['id','title','state','priority']:
       print(f'{k}: {data.get(k, "—")}')
   a = data.get('assignee', {})
   print(f'assignee: {a.get("fullName", "—")}')
   sprints = data.get('sprints', [])
   print(f'sprint: {sprints[0].get("name", "—") if sprints else "—"}')
   links = data.get('links', {})
   print(f'parent: {links.get("parent", "—")}')
   md = data.get('textMd', '')
   print(f'textMd: {len(md)} chars')
   print()
   print(md[:5000])
   PYEOF
   ```
   Покажи извлечённые поля: `id`, `title`, `state`, `priority`, `assignee`, `sprint`, `parent`, `textMd`.

5. **Выдели суть задачи** (2–3 предложения): что требовалось сделать, какие бизнес-правила, ожидаемое поведение.

### 1. Фетч и дифф

Для каждого URL: извлеки репо и IID, проверь локальный репо, сделай `git fetch origin merge-requests/<iid>/head:mr-<iid>`.
Diff: `git show --patch --find-renames mr-<iid>`, при необходимости `git diff origin/master..mr-<iid>`.

### 2. Чтение кода

Прочитай изменённые файлы и их потребителей. Для протокольных/API изменений проверь обе стороны.

### 3. Ревью по thermo-nuclear skill

Выполни ревью используя скилл thermo-nuclear-code-quality-review

### 4. Сверка с задачей

После ревью **обязательно** сравни реализацию с описанием задачи:

- Все ли пункты из описания задачи реализованы?
- Есть ли в коде поведение, противоречащее задаче?
- Есть ли лишние изменения, не упомянутые в задаче?
- Соответствует ли реализация бизнес-правилам из задачи?

Выведи результат сверки отдельной секцией.

## Формат вывода

```md
Проверял в `/home/user/echat/reviews`.

## Задача
- **ID**: EUTP-XXXXX (или «не найдена»)
- **Суть**: ...

## <repo> MR !<iid>

### Blocker / Major / Minor: <краткий заголовок>

- **Файл**: `<path>:<line>`
- **Проблема**: ...
- **Влияние**: ...
- **Предложение**: ...

## Сверка с задачей

| Пункт задачи | Статус | Комментарий |
|-------------|--------|-------------|
| ... | ✅ / ❌ / ⚠️ | ... |

Примечания: тесты не запускались / браузер недоступен / задача не скачана / etc.
```
