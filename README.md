# Goose Chrome Environment

Environment for [Goose Parser](https://github.com/redco/goose-parser) which allows to run it in Chromium via Puppeteer API

## ChromeEnvironment
This environment is used for running Parser with chrome headless.
```JS
const env = new ChromeEnvironment({
    url: 'http://google.com',
});
```
The main and only required parameter is `url`. It contains an url address of the site, where Parser will start.

This environment allows:
- execute dynamic JavaScript on the page
- use single proxy
- perform snapshots
- and more sweet features
