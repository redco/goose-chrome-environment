const defaults = require('lodash.defaults');
const sample = require('lodash.sample');
const clone = require('lodash.clone');
const AbstractEnvironment = require('goose-abstract-environment');
const debugLib = require('debug');
const puppeteer = require('puppeteer');
const path = require('path');
const { parse: parseUrl } = require('url');
const mkdir = require('mkdirp');
const fs = require('fs');

const debug = debugLib('ChromeEnvironment');
const puppeteerError = debugLib('Puppeteer:error');
const debugParser = debugLib('GoosePageContext');

/**
 * @param {string} currentUrl
 * @param {string} redirectUri
 * @returns {string}
 * @private
 */
function getRedirectUrl(currentUrl, redirectUri) {
  const parsedCurrentUrl = parseUrl(currentUrl);
  const parsedRedirectUri = parseUrl(redirectUri);
  const hostname = parsedRedirectUri.hostname || parsedCurrentUrl.hostname;
  const protocol = parsedRedirectUri.protocol || parsedCurrentUrl.protocol;

  return protocol + '//' + hostname + parsedRedirectUri.path;
}

/**
 * @param {Response} response
 * @returns {string}
 * @private
 */
function extractRedirectUrl(response) {
  const headers = response.headers();
  const headerKey = Object.keys(headers).find(key => key.toLowerCase() === 'location');
  return headerKey && headers[headerKey] ? getRedirectUrl(response.request().url(), headers[headerKey]) : '';
}

/**
 * @typedef {object} Proxy
 * @property {string} host
 * @property {number} port
 * @property {?string} username
 * @property {?string} password
 */

/**
 * @typedef {object} ProxyIndicator
 * @property {string} type
 * @property {string} level Possible levels - high, medium, low
 */

/**
 * type=redirect
 * @typedef {ProxyIndicator} RedirectProxyIndicator
 * @property {string} url
 */

/**
 * type=responseCode
 * @typedef {ProxyIndicator} ResponseCodeProxyIndicator
 * @property {number} code
 */

/**
 * @typedef {object} Resources
 * @property {?Array.<string>} allowed Only `allowed` resources will be loaded. Have higher priority than `denied`
 * @property {?Array.<string>} denied All except `denied` resources will be loaded
 */

/**
 * @typedef {object} Screen
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} PuppeteerEnvironmentOptions
 * @property {?number} timeout
 * @property {?boolean} ignoreSslErrors
 * @property {?boolean} headless
 * @property {?string} cookiesFile
 *
 * @property {?string} snapshot perform snapshot during parsing
 * @property {?string} snapshotDir directory for snapshots
 * @property {?Proxy|Array.<Proxy>} proxy single proxy or proxy list
 * @property {Array.<ProxyIndicator>} proxyIndicators Indicators which say that proxy became unreachable
 * @property {?function} proxyRotator proxy rotator function(proxyList, currentProxy) with context of this env. function
 * should return Proxy from the list
 * @property {?string|Array.<string>} userAgent user agent or list of agents for setting to puppeteer
 * @property {?Screen} screen screen dimensions
 * @property {?Resources} resources white and black lists for loading resources on the page
 */

/**
 * @type {PuppeteerEnvironmentOptions}
 */
const defaultOptions = {
  // Puppeteer options
  timeout: 60 * 1000,
  ignoreSslErrors: true,
  headless: true,
  cookiesFile: null,

  // Custom environment options
  snapshot: false,
  snapshotDir: 'snapshots',
  proxy: null,
  proxyRotator: null,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_4) AppleWebKit/600.7.12 (KHTML, like Gecko)' +
    ' Version/8.0.7 Safari/600.7.12',
  screen: {
    width: 1440,
    height: 900,
  },
  resources: {
    allowed: null,
    denied: null,
  },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
};

class ChromeEnvironment extends AbstractEnvironment {
  constructor(options) {
    debug('Initializing...');
    super(options);

    this._options = defaults(clone(options) || {}, defaultOptions);
    this._proxy = this._options.proxy;
    this._proxyIndicators = this._options.proxyIndicators || [];
    this._proxyErrors = [];
    this._proxyCurrent = null;
    this._url = options.url;
    this._redirectUrls = [];
    this._browser = null;
    this._page = null;
  }

  async prepare() {
    debug('Preparing...');
    if (this._browser && this._browser.process() && this._page) {
      debug('Already initialized.');
      return;
    }
    await super.prepare();
    await this._setup();
    await this._setViewport();
    await this._setUserAgent();
    await this._setTimeout();
    await this._handlePuppeteerEvents();
    if (this._url) {
      await this.goto(this._url);
    }
  }

  /**
   * Go to the page
   * @param {string} url
   * @return {Promise<{}>}
   */
  async goto(url) {
    if (!url) {
      throw new Error('Missing url parameter passed to ChromeEnvironment');
    }

    this._url = url;
    this._proxyErrors = [];
    this._redirectUrls = [];
    this._callbacks = [];

    await this._navigateTo(url);
    await this._validateProxy();
    await this._injectFiles(this._getVendors());
    return this._page;
  }

  setProxy(proxy) {
    this._proxy = proxy;
    return this;
  }

  getProxy() {
    return this._proxy;
  }

  getOption(name) {
    return this._options[name];
  }

  evaluateJs(...args) {
    const page = this._page;
    const evalFunc = args.pop();
    if (typeof evalFunc !== 'function') {
      throw new Error('You must pass function as last argument to ChromeEnvironment.evaluateJs');
    }
    args.unshift(evalFunc);

    return page.evaluate(...args);
  }

  /**
   * Take screen snapshot
   * @param {string} fileName
   * @returns {Promise}
   */
  async snapshot(fileName) {
    if (!this._options.snapshot) {
      return Promise.resolve();
    }

    const screenShotFilePath = path.join(this._options.snapshotDir, parseUrl(this._url).hostname);
    const screenShotFileName = path.join(screenShotFilePath, fileName + '.png');
    debug('.snapshot() to %s', screenShotFileName);
    await mkdir(screenShotFilePath);
    return this._page.screenshot({
      path: screenShotFileName,
      fullPage: true,
    });
  }

  async back() {
    debug('Back');
    return this._page.goBack();
  }

  async mouseClick(selector) {
    const position = await this._getElementPosition(selector);
    await this.mouseDown(selector);
    await this._page.mouse.click(position.x, position.y);
    await this.mouseUp(selector);
  }

  // eslint-disable-next-line no-unused-vars
  async mouseDown(selector) {
    return this._page.mouse.down({ button: 'left' });
  }

  // eslint-disable-next-line no-unused-vars
  async mouseUp(selector) {
    return this._page.mouse.up({ button: 'left' });
  }

  async _getElementPosition(selector) {
    // eslint-disable-next-line no-shadow
    const position = await this.evaluateJs(selector, /* @covignore */ (selector) => {
      // eslint-disable-next-line no-undef
      const node = Sizzle(selector)[0];
      if (!node) {
        return null;
      }

      const rect = node.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });

    if (!position) {
      throw new Error('Position of element ' + selector + ' was not found');
    }
    debug('Element position is %o', position);

    return position;
  }

  /**
   * Set up a fresh PuppeteerJS page.
   * @returns {Promise}
   * @private
   */
  async _setup() {
    await this._createInstance();
    await this._createPage();
  }

  /**
   * Create a puppeteerjs instance.
   * @returns {Promise}
   * @private
   */
  async _createInstance() {
    const { args } = this._options;
    const proxy = await this._rotateProxy();
    if (proxy) {
      args.push(`--proxy-server=${proxy.host}:${proxy.port}`);
    }
    this._browser = await puppeteer.launch({
      ignoreHTTPSErrors: this._options.ignoreSslErrors,
      headless: this._options.headless,
      args,
    });
  }

  /**
   * Creates new page in puppeteer
   * @returns {Promise}
   */
  async _createPage() {
    debug('._createPage() has called');
    this._page = await this._browser.newPage();
    if (this._proxyCurrent) {
      await this._page.authenticate(this._proxyCurrent);
    }
    await this._page.setRequestInterception(true);
  }

  /**
   * Tear down a PuppeteerJS instance.
   */
  // eslint-disable-next-line consistent-return
  async tearDown() {
    debug('._tearDownInstance() tearing down');
    if (!this._browser || !this._browser.process()) {
      debug('Puppeteer process already exited, not killing');
      return Promise.resolve();
    }

    if (this._page) {
      await this._page.close();
      delete this._page;
    }

    await this._browser.close();
    delete this._browser;
  }

  /**
   * Go to url
   * @param url
   * @returns {Promise}
   * @private
   */
  async _navigateTo(url) {
    debug('.goto() url: ' + url);
    return this._page.goto(url);
  }

  /**
   * Set the viewport.
   *
   * @returns {Promise}
   * @private
   */
  async _setViewport() {
    let screen = this._options.screen;
    if (Array.isArray(screen)) {
      screen = sample(screen);
    }
    const width = screen.width;
    const height = screen.height;
    debug('.viewport() to ' + width + ' x ' + height);
    const viewport = { width, height };
    this._options.screen = viewport;
    return this._page.setViewport(viewport);
  }

  /**
   * Set the user agent.
   *
   * @returns {Promise}
   * @private
   */
  async _setUserAgent() {
    let userAgent = this._options.userAgent;
    if (Array.isArray(userAgent)) {
      userAgent = sample(this._options.userAgent);
    }
    debug('.userAgent() to ' + userAgent);
    return this._page.setUserAgent(userAgent);
  }

  /**
   * Set Page timeout.
   *
   * @returns {Promise}
   * @private
   */
  async _setTimeout() {
    const timeout = this._options.timeout;
    debug('.timeout() to ' + timeout);
    return this._page.setDefaultNavigationTimeout(timeout);
  }

  /**
   * @param {Error} error
   */
  addProxyError(error) {
    this._proxyErrors.push(error);
  }

  /**
   * @returns {Array.<Error>}
   */
  getProxyErrors() {
    return this._proxyErrors;
  }

  /**
   * @param type
   * @returns {Array.<ProxyIndicator>}
   */
  getProxyIndicators(type) {
    return this._proxyIndicators.filter(item => item.type === type);
  }

  /**
   * @returns {Promise}
   * @private
   */
  _validateProxy() {
    return this.getProxyErrors().length === 0 ?
      Promise.resolve() :
      Promise.reject(this.getProxyErrors().pop());
  }

  /**
   * @param {ProxyIndicator} proxyIndicator
   * @returns {Error}
   */
  // eslint-disable-next-line class-methods-use-this
  createProxyError(proxyIndicator) {
    let msg;
    switch (proxyIndicator.type) {
      case 'redirect':
        msg = 'Proxy matched redirect';
        break;
      case 'responseCode':
        msg = 'Proxy matched response code';
        break;
      case 'captcha':
        msg = 'Captcha handled';
        break;
      default:
        throw new Error('Unsupported proxyIndicator');
    }
    const err = new Error(msg);
    err.proxyIndicator = proxyIndicator.type;
    err.proxyLevel = proxyIndicator.level || 'medium';

    return err;
  }

  /**
   * Set a proxy from the proxy list (unset previous one)
   *
   * @returns {Promise}
   * @private
   */
  async _rotateProxy() {
    const proxy = this._proxy;
    const currentProxy = this._proxyCurrent;
    if (!proxy) {
      return Promise.resolve(null);
    }
    if (Array.isArray(proxy)) {
      this._removeUnavailableProxy();
      const foundProxy = await (typeof this._options.proxyRotator === 'function') ?
        this._options.proxyRotator(proxy, currentProxy) :
        Promise.resolve(sample(proxy));
      this._proxyErrors = [];
      this._proxyCurrent = foundProxy;
    } else {
      this._proxyCurrent = this._proxy;
    }

    return this._proxyCurrent;
  }

  /**
   * Remove from proxy list one which doesn't work
   *
   * @returns {?Proxy}
   * @private
   */
  _removeUnavailableProxy() {
    const current = this._proxyCurrent;
    if (!Array.isArray(this._proxy) || this._proxy.length === 0 || current === null) {
      return null;
    }

    debug('._removeUnavailableProxy()');
    const index = this._proxy.findIndex(item => item.host === current.host && item.port === current.port);
    let proxy = null;
    if (index !== -1) {
      // cut off old used proxy from the list
      proxy = this._proxy.splice(index, 1);
    }
    return Array.isArray(proxy) ? proxy.pop() : null;
  }

  async _injectFiles(files) {
    return Promise.all(files.map((file) => {
      debug('injecting file %s', file);
      return this._injectFile(file);
    }));
  }

  async _injectFile(filePath) {
    const page = this._page;
    let contents = await new Promise((resolve, reject) => {
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      });
    });
    contents += '//# sourceURL=' + filePath.replace(/\n/g, '');
    return page.mainFrame().evaluate(contents);
  }

  /**
   * @param {string} [urlPattern]
   * @returns {boolean}
   */
  hasRedirect(urlPattern) {
    if (!urlPattern) {
      return this._redirectUrls.length > 0;
    }
    return this._redirectUrls.some(url => url.match(urlPattern) !== null);
  }

  _handlePuppeteerEvents() {
    const page = this._page;

    page.on('error', (e) => {
      puppeteerError('%s, trace %o', e.message, e.stack);
      // this._errbacks.splice(0).forEach(errback => errback(msg, trace));
    });

    page.on('pageerror', (e) => {
      puppeteerError('%s, trace %o', e.message, e.stack);
      // this._errbacks.splice(0).forEach(errback => errback(msg, trace));
    });

    // todo: make it workable
    page.on('console', (consoleMessage) => {
      const msg = consoleMessage.text();
      const regex = /^(\[GoosePageContext])(.+)/i;
      const found = msg.match(regex);

      if (found) {
        debugParser(found[2].trim());
      } else {
        debug('Puppeteer page message: ' + msg);
      }
    });

    page.on('load', () => {
      debug('Page loaded successfully');
      this.evaluateCallbacks('navigation');
    });

    const {
      allowed: allowedUrls,
      denied: blockedUrls,
    } = this._options.resources;
    const hasAllowedUrls = Array.isArray(allowedUrls) && allowedUrls.length > 0;
    const hasBlockedUrls = Array.isArray(blockedUrls) && blockedUrls.length > 0;

    page.on('request', (request) => {
      const url = request.url();
      debug('Requesting %s', url);
      this.evaluateCallbacks('request', url);

      const allowed = !hasAllowedUrls || allowedUrls.some(urlPattern => url.match(urlPattern));
      let blocked = false;
      if (!hasAllowedUrls && hasBlockedUrls) {
        blocked = blockedUrls.some(urlPattern => url.match(urlPattern) !== null);
      }

      if (!allowed || blocked) {
        // eslint-disable-next-line no-console
        console.log('[GoosePageContext] Resource ' + url.substr(0, 30) + ' was aborted');
        request.abort();
      } else {
        request.continue();
      }
    });

    page.on('response', (response) => {
      // debug('Resource received %o', { status: response.status(), url: response.request().url() });
      const url = response.request().url();
      // redirect has occurred
      if ([302, 301].includes(response.status())) {
        const redirectUrl = extractRedirectUrl(response) || '';

        // if current url matches with this._url or with the last redirect url from this._redirectUrls
        if (
          redirectUrl &&
          (
            url === this._url ||
            url === this._redirectUrls[this._redirectUrls.length - 1]
          )
        ) {
          debug('Redirect to %s', redirectUrl);
          this._redirectUrls.push(redirectUrl);
        }
        const matched = this.getProxyIndicators('redirect').find(item => redirectUrl.match(item.url));
        if (matched) {
          this.addProxyError(this.createProxyError(matched));
        }
      }
    });

    page.on('requestfailed', (request) => {
      const url = request.url();
      const failure = request.failure();
      debug('Navigation error %s %o', url, failure);
      const response = request.response();
      if (response) {
        const matched = this.getProxyIndicators('responseCode').find(item => item.code === response.status);
        if (matched) {
          this.addProxyError(this.createProxyError(matched));
        }
      }

      if (url === this._url) {
        this.evaluateCallbacks('navigation', url, { error: new Error('Page is not loaded') });
      }
    });
  }
}

module.exports = ChromeEnvironment;
