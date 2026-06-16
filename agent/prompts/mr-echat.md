---
description: Commit + push + create MR via glab
argument-hint: "[<commit-title>]"
---
Ты — агент автоматизации git и glab. Выполни строго по шагам, останавливайся при ошибке.

## 1. Извлеки номер задачи из ветки
Выполни: `git branch --show-current`
Из названия ветки извлеки номер задачи по шаблону `EUTP-\d+`.
Если номер не найден — остановись и скажи об этом.

## 2. Прочитай шаблон MR и проанализируй изменения
Прочитай файл `.gitlab/merge_request_templates/Default.md` из корня репозитория.
Замени `http://youtrack.esoft.tech/issue/EUTP-…` на `https://youtrack.esoft.tech/issue/EUTP-<номер>`.

Определи, какие изменения анализировать:
```bash
git diff --cached --name-only   # есть ли staged изменения
git diff --name-only            # есть ли unstaged изменения
```
- **Если есть и staged, и unstaged** — анализируй только staged: `git diff --cached`
- **Если staged пуст (всё unstaged)** — анализируй всё: `git diff`

Проанализируй diff и заполни секции **markdown-списками** (`- `):

Замени блок "На что обратить внимание при ревью и тестировании" на:
```
### Краткое описание изменений

- <пункт 1>
- <пункт 2>
- ...

### Что нужно проверить тестировщикам

- <пункт 1>
- <пункт 2>
- ...
```

Где:
- **Краткое описание изменений** — каждый пункт: одно изменение/фича/фикс, затронутые файлы/модули.
- **Что нужно проверить тестировщикам** — каждый пункт: конкретный сценарий или компонент для ручного тестирования.

Сохрани готовый description во временный файл:
```bash
cat > /tmp/mr_description.md << 'DESC_EOF'
<содержимое description>
DESC_EOF
```

## 3. Определи commit title
**Если пользователь передал аргумент** — используй его как commit_title:
```
commit_title = "<аргумент> #EUTP-<номер>"
```

**Если аргумент не передан** — сгенерируй название коммита на основе проанализированного diff.
Стиль коммитов (примеры из репозитория):
```
add cross-app text formatting copy-paste; add RichTextInput for adding/editing message templates #EUTP-145771
fix chat closing animation on mobile #EUTP-146265
add invitation links #EUTP-115210
make container_buind manual job without manual image name input #EUTP-146545
fix formatting toolbar on Android #EUTP-144804
```

Правила:
- На английском, lowercase, imperative mood (add/fix/make/update/remove)
- Кратко описывает суть изменений (одно предложение, реже два через `; `)
- Завершается ` #EUTP-<номер>`

Сгенерировав название, покажи его пользователю и спроси, подходит ли.
Если пользователь отклоняет — предложи другой вариант.
Повторяй, пока пользователь не согласится или не предложит название сам.

## 4. Commit + push
Проверь статус staging-а:
```bash
git diff --cached --name-only   # есть ли staged изменения
git diff --name-only            # есть ли unstaged изменения
```

**Если есть и staged, и unstaged изменения** — коммитим и пушим только staged (unstaged не трогаем):
```bash
git commit -m "<commit_title>"
git push origin HEAD
```

**Если staged пуст (всё unstaged)** — добавляем всё:
```bash
git add -A
git commit -m "<commit_title>"
git push origin HEAD
```

## 5. Проверь существующий MR
```bash
glab mr list --source-branch "$(git branch --show-current)" --output json 2>/dev/null
```
Если вывод непустой и не равен `[]` — MR уже существует. Извлеки `web_url` из JSON и выведи его. Остановись.

## 6. Создай MR
```bash
glab mr create \
  --title "<commit_title>" \
  --description "$(cat /tmp/mr_description.md)" \
  --assignee "$(glab api user | jq -r '.username')" \
  --remove-source-branch \
  --yes
```

## 7. Выведи результат
Выведи ссылку на созданный MR (web_url из вывода glab).
