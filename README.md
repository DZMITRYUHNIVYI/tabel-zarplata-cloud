# Табели и зарплаты — облачная версия

Эта папка подготовлена для приватного GitHub-репозитория и публикации через Render.

Постоянные данные хранятся на диске Render в `/var/data`. Начальная копия данных находится в `data/tabel-state.json`; при первой публикации она переносится на этот диск.

В Render добавляются секреты `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY` и `PUBLIC_BASE_URL`. Их нельзя помещать в GitHub или отправлять в группы Telegram.
