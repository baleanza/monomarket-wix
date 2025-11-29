# Monomarket Murkit XML Feed

Serverless-ендпоинт для генерації XML-фіду `offers` (формат Murkit) з Google Sheets та кешуванням у Google Drive.

## Структура проекту

- `api/monomarket-offers.js` – основний endpoint XML-фіду
- `api/monomarket-stock.js` – заглушка під майбутній stock-фід
- `lib/sheetsClient.js` – клієнт Google Sheets API
- `lib/driveClient.js` – клієнт Google Drive API
- `lib/feedBuilder.js` – збірка XML з даних таблиці
- `lib/helpers.js` – утиліти (escape, конвертація одиниць, boolean → Так/Ні)
- `tests/*` – unit-тести (Jest)
- `package.json`

## Google Service Account

1. У Google Cloud Console створіть **Service Account**.
2. Створіть ключ у форматі JSON та завантажте.
3. Скопіюйте JSON в env змінну `GOOGLE_SERVICE_ACCOUNT_KEY` (повна JSON-строка).
4. Візьміть email сервіс-акаунта (`...@...gserviceaccount.com`) і розшарте на нього:
   - Google Spreadsheet (роль **Viewer/Reader** або вище).
   - Google Drive (папка або конкретний файл, якщо створюєте наперед).

## Структура Google Sheets

### Лист `Import`

- 1 рядок – заголовки (`code`, `title`, `vendor_code`, `brand`, `barcode`, `weight`, `height`, `width`, `length`, `description`, `image_1`, `image_2`, …).
- Дані з 2-го рядка – товари.

### Лист `Feed Control List`

- A: `Import field`
- B: `Enabled` (`TRUE/FALSE/1/0`)
- C: `Feed name` (xml-тег або `tags`, `image_1`…)
- D: `Units` (`мм`, `см`, `м`, `г`, `кг` або порожньо)

## Env змінні

У Vercel → Project → Settings → Environment Variables:

- `GOOGLE_SERVICE_ACCOUNT_KEY` – повний JSON ключ сервіс-акаунта.
- `SPREADSHEET_ID` – ID Google Spreadsheet.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` – email сервіс-акаунта (для довідки).
- `CACHE_TTL_SECONDS` – опціонально, TTL кешу в секундах (за замовчуванням `7200`).
- `API_KEY` – опціонально, якщо треба закрити endpoint по ключу (`x-api-key`).

## Поведінка / кешування

- `GET /api/monomarket-offers`
  - Якщо у Google Drive існує `monomarket-offers.xml` і він свіжіший, ніж `CACHE_TTL_SECONDS`, файл читається та повертається напряму.
  - Якщо файл старий або відсутній – зчитується таблиця, генерується XML, файл перезаписується у Drive, і результат повертається.
- HTTP заголовки:
  - `Content-Type: application/xml; charset=utf-8`
  - `Cache-Control: public, s-maxage=7200, max-age=0` (або з урахуванням `CACHE_TTL_SECONDS`).

## Захист API

Якщо задано `API_KEY`, endpoint `GET /api/monomarket-offers` вимагає заголовок:
x-api-key: <ваш_API_KEY>
Інакше повертається `401 Unauthorized`.

## Деплой на Vercel

1. Створіть репозиторій з цією структурою.
2. Залогінтеся в Vercel та імпортуйте репозиторій.
3. Налаштуйте env variables.
4. Задеплойте.
5. Перевірка:
   - `GET https://<your-project>.vercel.app/api/monomarket-offers`
   - Додайте `x-api-key`, якщо використовується.

## Оновлення файлу в Drive

- Файл `monomarket-offers.xml` створюється автоматично при першому запиті.
- Щоб зробити його публічним:
  - У Google Drive змініть доступ файлу на “Anyone with the link – Viewer”.
  - Або залиште закритим і віддавайте тільки через Vercel-проксі.

## Force перегенерація

Опційно можна додати `/api/rebuild` endpoint, який:
- Ігнорує кеш.
- Завжди перечитує Google Sheets і перезаписує XML у Drive.
- Захищений `API_KEY` (обов’язковий).

## Тести
npm install
npm test

