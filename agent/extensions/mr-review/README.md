# Review extension

Расширение подготавливает контекст для ревью GitLab MR и локальных изменений EChat, добавляет его прямо в пользовательский запрос и запускает глобальный skill `mr-review`.

## Команды

Основная команда — `/review`. Вызов без аргументов открывает интерактивную форму:

```text
/review
```

После выбора «Локальные изменения» открывается мультивыбор репозиториев из `/home/user/echat`. Space переключает текущий репозиторий, Enter подтверждает выбор и открывает следующий шаг. Выбранные пути будут подставлены в поле `Репозитории (по одному в строке)` общей текстовой формы, где их можно дополнительно отредактировать вместе с base, scope, PORA и контекстом задачи.

Команда `/mr-review` сохранена как совместимый alias и принимает те же аргументы.

После изменения расширения или skill выполни:

```text
/reload
```

## Ревью GitLab MR

Один MR:

```text
/review mr https://git.esoft.tech/tidy/tidy-client/-/merge_requests/2301
```

Несколько MR одной задачи:

```text
/review mr https://git.esoft.tech/tidy/tidy-client/-/merge_requests/2301 https://git.esoft.tech/tidy/tidy-rest/-/merge_requests/1693
```

Префикс `mr` можно опустить:

```text
/review https://git.esoft.tech/tidy/tidy-client/-/merge_requests/2301
```

Для MR расширение использует изолированные клоны из `/home/user/echat/reviews/<repo>`. MR загружается в служебный ref `refs/mr-review/<repo>/<iid>`, поэтому текущая ветка clone не переключается.

Если `PORA_SESSION` отсутствует, интерактивный режим предложит вставить `pora-gatekeeper-session`. В CLI-вызове токен можно передать после ссылок для обратной совместимости:

```text
/review mr <MR-URL> <pora-session>
```

## Ревью локальных изменений

Локальные репозитории читаются напрямую из `/home/user/echat`, поэтому ветку не нужно push-ить или переносить в review clone.

Имя репозитория разрешается относительно `/home/user/echat`:

```text
/review local tidy-client
```

Можно передать относительный или абсолютный путь:

```text
/review local ../tidy-client
/review local /home/user/echat/tidy-client
```

Multi-repo задача:

```text
/review local tidy-client tidy-rest tidy-server
```

Явная базовая ветка:

```text
/review local tidy-client --base origin/stage
```

Без `--base` для локального ревью используется ветка `master`.

## Scope локального ревью

По умолчанию используется `all`.

Только коммиты текущей ветки относительно merge base:

```text
/review local tidy-client --scope branch
```

Только staged, unstaged и untracked изменения рабочего дерева:

```text
/review local tidy-client --scope working-tree
```

Коммиты ветки и все изменения рабочего дерева:

```text
/review local tidy-client --scope all
```

Untracked-файлы перечисляются в контексте запроса отдельно, потому что обычный `git diff` их не показывает.

## Дополнительный контекст

При вызове `/review` без аргументов форма позволяет указать:

- несколько MR или локальных репозиториев;
- PORA token;
- дополнительную информацию к задаче;
- связанные EUTP-задачи для сопоставления;
- base и scope для локального ревью.

EUTP-ID определяется по имени ветки, metadata MR и сообщениям коммитов. Если задача найдена и доступен PORA token, её описание добавляется в запрос. Отсутствие EUTP-ID не блокирует локальное ревью.

## Контекст запроса

Расширение добавляет в тело запроса:

- абсолютные пути репозиториев;
- source/base/head refs и merge base;
- состояние рабочего дерева;
- untracked-файлы;
- команды для получения точного diff;
- основную и связанные YouTrack-задачи;
- дополнительный пользовательский контекст.

После подготовки расширение отправляет:

```text
/skill:mr-review

# Review context
...
```

Отдельный файл не создаётся. Skill получает весь контекст в аргументах команды, загружает `thermo-nuclear-code-quality-review`, исследует изменённый код и формирует итоговое ревью. Само расширение отвечает только за Git/GitLab/PORA/TUI-интеграцию и сбор review scope.
