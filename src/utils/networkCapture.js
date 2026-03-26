const fs = require('fs');
const path = require('path');

class NetworkCapture {
  constructor({ sessionId, accountId, logsRoot, captureBodies = true }) {
    this.sessionId = sessionId;
    this.accountId = accountId || `acc${sessionId}`;
    this.captureBodies = captureBodies;
    this.logsRoot = logsRoot;
    this.networkDir = path.join(logsRoot, 'network');
    this.harDir = path.join(logsRoot, 'har');
    this.page = null;
    this.startedAt = null;
    this.pageStartedAt = null;
    this.requestSeq = 0;
    this.requestMap = new Map();
    this.eventLog = [];
    this.harEntries = [];
    this.flushCounter = 0;
    this.boundHandlers = null;

    fs.mkdirSync(this.networkDir, { recursive: true });
    fs.mkdirSync(this.harDir, { recursive: true });

    this.baseFileName = `${this.accountId}-session${this.sessionId}`;
    this.jsonPath = path.join(this.networkDir, `${this.baseFileName}.json`);
    this.harPath = path.join(this.harDir, `${this.baseFileName}.har`);
  }

  async start(page) {
    if (this.page) return;
    this.page = page;
    this.startedAt = new Date().toISOString();
    this.pageStartedAt = this.startedAt;

    this.boundHandlers = {
      request: (request) => this.onRequest(request),
      response: (response) => this.onResponse(response),
      requestfailed: (request) => this.onRequestFailed(request)
    };

    page.on('request', this.boundHandlers.request);
    page.on('response', this.boundHandlers.response);
    page.on('requestfailed', this.boundHandlers.requestfailed);

    this.flushToDisk();
  }

  async stop() {
    if (!this.page || !this.boundHandlers) {
      this.flushToDisk();
      return;
    }

    this.page.off('request', this.boundHandlers.request);
    this.page.off('response', this.boundHandlers.response);
    this.page.off('requestfailed', this.boundHandlers.requestfailed);
    this.boundHandlers = null;
    this.page = null;
    this.flushToDisk();
  }

  onRequest(request) {
    const id = ++this.requestSeq;
    const startedMs = Date.now();
    const urlObj = this.safeUrl(request.url());
    const headers = request.headers ? request.headers() : {};
    const postDataBuffer = request.postDataBuffer ? request.postDataBuffer() : null;

    const requestRecord = {
      id,
      startedMs,
      startedDateTime: new Date(startedMs).toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers,
      query: urlObj ? this.queryToArray(urlObj) : [],
      postData: this.serializeBuffer(postDataBuffer, headers['content-type'] || headers['Content-Type']),
      frameUrl: request.frame()?.url?.() || null,
      redirectedFrom: request.redirectedFrom()?.url?.() || null,
      response: null,
      failure: null
    };

    this.requestMap.set(request, requestRecord);
    this.eventLog.push({
      type: 'request',
      ...requestRecord
    });
  }

  async onResponse(response) {
    const request = response.request();
    const record = this.requestMap.get(request);
    if (!record) return;

    const finishedMs = Date.now();
    const responseHeaders = response.headers ? response.headers() : {};
    const contentType = responseHeaders['content-type'] || responseHeaders['Content-Type'] || '';
    let bodyData = null;

    if (this.captureBodies) {
      try {
        const bodyBuffer = await response.body();
        bodyData = this.serializeBuffer(bodyBuffer, contentType);
      } catch (error) {
        bodyData = {
          omitted: true,
          reason: `Unable to read body: ${error.message}`
        };
      }
    }

    record.response = {
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      headers: responseHeaders,
      contentType,
      body: bodyData,
      finishedMs,
      durationMs: Math.max(0, finishedMs - record.startedMs)
    };

    this.harEntries.push(this.buildHarEntry(record));
    this.eventLog.push({
      type: 'response',
      requestId: record.id,
      finishedDateTime: new Date(finishedMs).toISOString(),
      durationMs: record.response.durationMs,
      response: record.response
    });

    this.requestMap.delete(request);
    this.flushMaybe();
  }

  onRequestFailed(request) {
    const record = this.requestMap.get(request);
    if (!record) return;

    const finishedMs = Date.now();
    const failure = request.failure ? request.failure() : null;
    record.failure = {
      errorText: failure?.errorText || 'Request failed',
      finishedMs,
      durationMs: Math.max(0, finishedMs - record.startedMs)
    };

    this.eventLog.push({
      type: 'requestfailed',
      requestId: record.id,
      finishedDateTime: new Date(finishedMs).toISOString(),
      failure: record.failure
    });

    this.harEntries.push(this.buildHarEntry(record));
    this.requestMap.delete(request);
    this.flushMaybe();
  }

  buildHarEntry(record) {
    const response = record.response;
    const failure = record.failure;
    const totalTime = response?.durationMs || failure?.durationMs || 0;

    return {
      startedDateTime: record.startedDateTime,
      time: totalTime,
      request: {
        method: record.method,
        url: record.url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: this.headersToArray(record.headers),
        queryString: record.query,
        postData: record.postData?.omitted ? undefined : this.buildHarPostData(record.postData),
        headersSize: -1,
        bodySize: record.postData?.size ?? -1
      },
      response: {
        status: response?.status || 0,
        statusText: response?.statusText || (failure ? failure.errorText : ''),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: this.headersToArray(response?.headers || {}),
        content: {
          size: response?.body?.size ?? 0,
          mimeType: response?.contentType || '',
          text: response?.body?.text,
          encoding: response?.body?.encoding
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: response?.body?.size ?? -1,
        _failure: failure || undefined
      },
      cache: {},
      timings: {
        blocked: -1,
        dns: -1,
        connect: -1,
        ssl: -1,
        send: 0,
        wait: totalTime,
        receive: 0
      },
      pageref: 'page_1'
    };
  }

  buildHarPostData(postData) {
    if (!postData || postData.omitted) return undefined;
    return {
      mimeType: postData.mimeType || 'application/octet-stream',
      text: postData.text,
      encoding: postData.encoding
    };
  }

  serializeBuffer(buffer, contentType = '') {
    if (!buffer) return null;

    const mimeType = contentType || 'application/octet-stream';
    const isTextLike = /(json|text|javascript|xml|html|x-www-form-urlencoded)/i.test(mimeType);

    if (isTextLike) {
      return {
        mimeType,
        size: buffer.length,
        encoding: 'utf8',
        text: buffer.toString('utf8')
      };
    }

    return {
      mimeType,
      size: buffer.length,
      encoding: 'base64',
      text: buffer.toString('base64')
    };
  }

  headersToArray(headers) {
    return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
  }

  queryToArray(urlObj) {
    return Array.from(urlObj.searchParams.entries()).map(([name, value]) => ({ name, value }));
  }

  safeUrl(url) {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  }

  flushMaybe() {
    this.flushCounter += 1;
    if (this.flushCounter % 5 === 0) {
      this.flushToDisk();
    }
  }

  flushToDisk() {
    const summary = {
      sessionId: this.sessionId,
      accountId: this.accountId,
      startedAt: this.startedAt,
      lastUpdatedAt: new Date().toISOString(),
      completedEntries: this.harEntries.length,
      pendingRequests: this.requestMap.size
    };

    const jsonPayload = {
      summary,
      events: this.eventLog
    };

    const harPayload = {
      log: {
        version: '1.2',
        creator: {
          name: 'Playwright_TS Custom Network Capture',
          version: '1.0'
        },
        pages: [
          {
            startedDateTime: this.pageStartedAt || new Date().toISOString(),
            id: 'page_1',
            title: `${this.accountId}-session${this.sessionId}`,
            pageTimings: {}
          }
        ],
        entries: this.harEntries
      }
    };

    fs.writeFileSync(this.jsonPath, JSON.stringify(jsonPayload, null, 2), 'utf-8');
    fs.writeFileSync(this.harPath, JSON.stringify(harPayload, null, 2), 'utf-8');
  }
}

module.exports = NetworkCapture;