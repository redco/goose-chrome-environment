# Goose Chrome Environment

[![Build Status](https://img.shields.io/circleci/project/github/redco/goose-chrome-environment.svg?style=flat)](https://circleci.com/gh/redco/goose-chrome-environment)
[![Latest Stable Version](https://img.shields.io/npm/v/goose-chrome-environment.svg?style=flat)](https://www.npmjs.com/package/goose-chrome-environment)
[![Total Downloads](https://img.shields.io/npm/dt/goose-chrome-environment.svg?style=flat)](https://www.npmjs.com/package/goose-chrome-environment)

Environment for [Goose Parser](https://github.com/redco/goose-parser) which allows to run it in Chromium via [Puppeteer API](https://github.com/GoogleChrome/puppeteer)

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
