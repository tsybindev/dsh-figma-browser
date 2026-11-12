# dsh-figma-browser

**Русский** | [English](README.en.md)

[![ci](https://github.com/tsybindev/dsh-figma-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/tsybindev/dsh-figma-browser/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Плагин для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), который отдаёт агенту макеты Figma **точными данными и настоящими рендерами** через твой собственный Chrome с уже открытой сессией. Без токена Figma, без платного места, без Dev Mode и без API-лимитов.

```
figma_node { "nodeId": "25:148", "render": true, "scale": 2 }
→ PNG кадра, экспортированный самой Figma
→ Inter Bold 19.51px, заливка #33435E, радиус 12, автолейаут 16/24/4, …
```

## Зачем

Публичный Figma REST API упирается в токен и тариф, Figma MCP — в OAuth, allowlist клиентов и десктопное приложение, Dev Mode — в платное место. При этом веб-редактор Figma держит внутри страницы **настоящий plugin API** — `window.figma` с `getNodeById`, `root`, `currentPage`, `exportAsync`, `variables`. Плагин открывает файл в Chrome под твоей сессией, подключается к вкладке по Chrome DevTools Protocol и читает документ через этот API. Поэтому работает и на бесплатном тарифе.

## Как это работает

1. Chrome запускается с `--remote-debugging-port` на **копии** профиля (`Local State`, `Cookies`, `Local Storage`, `IndexedDB`, …). С Chrome 136 отладочные ключи игнорируются на дефолтном каталоге данных, поэтому копия — единственный способ сохранить куки и авторизацию.
2. Headless-запуск подставляет обычный Chrome User-Agent: CDN Figma отвечает `403 Request blocked` на токен `HeadlessChrome`.
3. Плагин подключается к вкладке редактора по CDP (встроенный `WebSocket` платформы) и выполняет небольшой сериализатор против `window.figma`.
4. Рендеры отдаёт `node.exportAsync`, то есть картинку рисует сама Figma.

Никаких рантайм-зависимостей: без Playwright, без Puppeteer, без скачивания браузеров.

## Установка

```bash
# из npm
dsh plugin add dsh-figma-browser

# из локального клона
dsh plugin add /path/to/dsh-figma-browser
```

В веб-интерфейсе: **Plugins → Add plugin** → имя пакета или путь к каталогу. Бандл host-only: сборка не нужна.

Дальше в новой сессии:

```
figma_browser { "action": "open", "url": "https://www.figma.com/design/<file>?node-id=25-147" }
```

## Инструменты

| Инструмент | Параметры | Результат |
|---|---|---|
| `figma_browser` | `action: status \| start \| stop \| open`, `url` | состояние браузера или открытая вкладка |
| `figma_list` | `action: pages \| search \| selection`, `query`, `limit` | страницы файла, найденные узлы, текущее выделение |
| `figma_node` | `nodeId`, `depth`, `render`, `format`, `scale` | геометрия, заливки, градиенты, эффекты, автолейаут, текст и шрифт, дети; опционально PNG/SVG |
| `figma_view` | `nodeId?`, `format?` | скриншот редактора, при необходимости с выделенным узлом |
| `figma_eval` | `expression` | только при `allowEval: true` |

`nodeId` принимает `25:147`, `25-147` или полную ссылку Figma; ссылка ещё и откроет нужный файл.

## Настройка

| Поле | По умолчанию | Значение |
|---|---|---|
| `port` | `9333` | порт DevTools, слушается только `127.0.0.1` |
| `headless` | `false` | запуск без окна; в headless не видно действий агента |
| `autoStart` | `true` | поднимать браузер самому, если его нет |
| `allowEval` | `false` | регистрировать `figma_eval` (произвольный JS в странице) |
| `chromePath` | автоопределение | путь к Chrome/Chromium |
| `sourceProfile` | автоопределение | каталог реального профиля, копируемый один раз |
| `profileDir` | `~/.dsh/figma-browser/profile` | где живёт копия профиля |
| `outputDir` | `~/.dsh/figma-browser/out` | куда пишутся JSON и рендеры |
| `userAgent` | автоопределение | User-Agent для headless |
| `startupTimeoutMs` | `20000` | сколько ждать запуска браузера |
| `extraArgs` | `[]` | дополнительные ключи Chrome, например `--no-sandbox` в контейнере |

Если окно не нужно, поставь `headless: true`; если у машины нет дисплея, плагин сам откатится на headless.

Локальные настройки живут в профильном патче и переживают обновление плагина:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- override:
    - id: figma-browser
      config:
        headless: true
        allowEval: true
```

## Проверка

```bash
npm run check   # синтаксис всех модулей
npm test        # smoke-тест против браузера, слушающего :9333
```

## Ограничения

- Только Figma; копия профиля выделена под плагин, это не твоё живое окно Chrome.
- `window.figma` — внутренний механизм Figma, а не публичный API. Если его уберут, останутся скриншоты канваса.
- Копия делается один раз. Когда сессия истечёт, удали `profileDir` при закрытом Chrome и запусти заново.
- Все сессии на машине делят один экземпляр браузера и один порт.
- Плагин ничего не меняет в файле сам: запись возможна только если агент прямо попросят, а `figma_eval` по умолчанию выключен.

## Безопасность

- В копии профиля лежат твои куки. Не коммить её и не выкладывай.
- Пока порт открыт, любой локальный процесс может управлять этим браузером. Закончил — `figma_browser { "action": "stop" }`.
- Если не хочешь копировать куки всех сайтов, сделай отдельный профиль Chrome для Figma.

## Структура

```
src/cdp.js      CDP-клиент на встроенном WebSocket
src/browser.js  жизненный цикл Chrome, копия профиля
src/figma.js    операции внутри редактора (window.figma)
src/index.js    регистрация инструментов
test/smoke.mjs  smoke-тест против живого браузера
```

## Лицензия

MIT
