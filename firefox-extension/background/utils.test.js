'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  withTimeout,
  RateLimiter,
  RequestDeduplicator,
  RequestQueueManager,
  HealthChecker,
} = require('./utils');

// ── withTimeout ──────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    assert.equal(result, 42);
  });

  it('rejects when promise exceeds timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await assert.rejects(
      () => withTimeout(slow, 50, '太慢了'),
      (err) => {
        assert.ok(err.message.includes('太慢了'));
        assert.ok(err.message.includes('50ms'));
        return true;
      },
    );
  });

  it('uses default error message', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await assert.rejects(
      () => withTimeout(slow, 50),
      (err) => {
        assert.ok(err.message.includes('操作超时'));
        return true;
      },
    );
  });

  it('propagates original promise rejection', async () => {
    const failing = Promise.reject(new Error('原始错误'));
    await assert.rejects(
      () => withTimeout(failing, 1000),
      (err) => {
        assert.equal(err.message, '原始错误');
        return true;
      },
    );
  });
});

// ── RateLimiter ──────────────────────────────────────────────────────

describe('RateLimiter', () => {
  it('allows requests within the limit', () => {
    const limiter = new RateLimiter(5, 1000, 5000);
    for (let i = 0; i < 5; i++) {
      const result = limiter.check();
      assert.equal(result.allowed, true);
    }
  });

  it('blocks when limit is exceeded', () => {
    const limiter = new RateLimiter(3, 1000, 5000);
    limiter.check();
    limiter.check();
    limiter.check();

    const result = limiter.check();
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfter > 0);
    assert.ok(result.reason);
  });

  it('remains blocked during block duration', () => {
    const limiter = new RateLimiter(1, 1000, 10000);
    limiter.check();
    limiter.check(); // triggers block

    const result = limiter.check();
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('秒后重试'));
  });

  it('getStatus reports current state', () => {
    const limiter = new RateLimiter(10, 1000, 5000);
    limiter.check();
    limiter.check();

    const status = limiter.getStatus();
    assert.equal(status.currentRequests, 2);
    assert.equal(status.maxRequests, 10);
    assert.equal(status.isBlocked, false);
    assert.equal(status.blockedUntil, null);
  });

  it('reset clears all state', () => {
    const limiter = new RateLimiter(2, 1000, 5000);
    limiter.check();
    limiter.check();
    limiter.check(); // triggers block

    limiter.reset();

    const status = limiter.getStatus();
    assert.equal(status.currentRequests, 0);
    assert.equal(status.isBlocked, false);

    const result = limiter.check();
    assert.equal(result.allowed, true);
  });
});

// ── RequestDeduplicator ──────────────────────────────────────────────

describe('RequestDeduplicator', () => {
  let dedup;
  beforeEach(() => { dedup = new RequestDeduplicator(5000); });

  describe('checkRequest', () => {
    it('returns isDuplicate: false for new requests', () => {
      const result = dedup.checkRequest('req-1');
      assert.equal(result.isDuplicate, false);
    });

    it('returns isDuplicate: false for null/undefined requestId', () => {
      assert.equal(dedup.checkRequest(null).isDuplicate, false);
      assert.equal(dedup.checkRequest(undefined).isDuplicate, false);
    });

    it('returns isDuplicate: true for processing request', () => {
      dedup.markProcessing('req-1');
      const result = dedup.checkRequest('req-1');
      assert.equal(result.isDuplicate, true);
      assert.ok(result.reason);
    });

    it('returns isDuplicate: false for completed request', () => {
      dedup.markProcessing('req-1');
      dedup.markCompleted('req-1');
      const result = dedup.checkRequest('req-1');
      assert.equal(result.isDuplicate, false);
    });
  });

  describe('markProcessing / markCompleted', () => {
    it('ignores null requestId', () => {
      dedup.markProcessing(null);
      assert.equal(dedup.getStatus().processingCount, 0);
    });

    it('markCompleted removes the entry', () => {
      dedup.markProcessing('req-1');
      assert.equal(dedup.getStatus().processingCount, 1);
      dedup.markCompleted('req-1');
      assert.equal(dedup.getStatus().processingCount, 0);
    });
  });

  describe('URL tab cache', () => {
    it('checkUrlTab returns hasExisting: false for unknown URL', () => {
      const result = dedup.checkUrlTab('https://a.com');
      assert.equal(result.hasExisting, false);
    });

    it('cacheUrlTab stores and checkUrlTab retrieves', () => {
      dedup.cacheUrlTab('https://a.com', 42);
      const result = dedup.checkUrlTab('https://a.com');
      assert.equal(result.hasExisting, true);
      assert.equal(result.tabId, 42);
    });

    it('returns hasExisting: false for null URL', () => {
      assert.equal(dedup.checkUrlTab(null).hasExisting, false);
    });

    it('cacheUrlTab ignores null url or tabId', () => {
      dedup.cacheUrlTab(null, 1);
      dedup.cacheUrlTab('https://a.com', null);
      assert.equal(dedup.getStatus().urlCacheCount, 0);
    });
  });

  describe('getStatus', () => {
    it('reports counts correctly', () => {
      dedup.markProcessing('r1');
      dedup.markProcessing('r2');
      dedup.cacheUrlTab('https://a.com', 1);

      const status = dedup.getStatus();
      assert.equal(status.processingCount, 2);
      assert.equal(status.urlCacheCount, 1);
    });
  });

  describe('reset', () => {
    it('clears all data', () => {
      dedup.markProcessing('r1');
      dedup.cacheUrlTab('https://a.com', 1);
      dedup.reset();

      const status = dedup.getStatus();
      assert.equal(status.processingCount, 0);
      assert.equal(status.urlCacheCount, 0);
    });
  });
});

// ── RequestQueueManager ──────────────────────────────────────────────

describe('RequestQueueManager', () => {
  let queue;
  beforeEach(() => { queue = new RequestQueueManager(5, 30000); });

  describe('add', () => {
    it('accepts request when queue has capacity', () => {
      const result = queue.add('r1', 'open_url');
      assert.equal(result.accepted, true);
      assert.equal(result.queueSize, 1);
    });

    it('rejects when queue is full', () => {
      for (let i = 0; i < 5; i++) queue.add(`r${i}`, 'test');

      const result = queue.add('overflow', 'test');
      assert.equal(result.accepted, false);
      assert.ok(result.reason.includes('已满'));
    });

    it('stores metadata', () => {
      queue.add('r1', 'execute_script', { tabId: '5' });
      assert.equal(queue.has('r1'), true);
    });
  });

  describe('remove', () => {
    it('removes existing request', () => {
      queue.add('r1', 'test');
      queue.remove('r1');
      assert.equal(queue.has('r1'), false);
    });

    it('is safe to call with non-existent ID', () => {
      queue.remove('nonexistent'); // should not throw
    });
  });

  describe('has', () => {
    it('returns true for existing requests', () => {
      queue.add('r1', 'test');
      assert.equal(queue.has('r1'), true);
    });

    it('returns false for non-existent requests', () => {
      assert.equal(queue.has('r1'), false);
    });
  });

  describe('getStatus', () => {
    it('reports queue size and utilization', () => {
      queue.add('r1', 'open_url');
      queue.add('r2', 'get_html');

      const status = queue.getStatus();
      assert.equal(status.size, 2);
      assert.equal(status.maxSize, 5);
      assert.equal(status.utilization, '40.0%');
      assert.equal(status.requests.length, 2);
    });
  });

  describe('cleanupExpired', () => {
    it('removes requests older than timeout', () => {
      const shortQueue = new RequestQueueManager(10, 50);
      shortQueue.add('r1', 'test');

      return new Promise((resolve) => {
        setTimeout(() => {
          const expired = shortQueue.cleanupExpired();
          assert.equal(expired.length, 1);
          assert.equal(expired[0].requestId, 'r1');
          assert.equal(shortQueue.has('r1'), false);
          resolve();
        }, 100);
      });
    });

    it('keeps non-expired requests', () => {
      queue.add('r1', 'test');
      const expired = queue.cleanupExpired();
      assert.equal(expired.length, 0);
      assert.equal(queue.has('r1'), true);
    });
  });

  describe('reset', () => {
    it('clears all requests', () => {
      queue.add('r1', 'test');
      queue.add('r2', 'test');
      queue.reset();
      assert.equal(queue.getStatus().size, 0);
    });
  });
});

// ── HealthChecker ────────────────────────────────────────────────────

describe('HealthChecker', () => {
  let checker;
  beforeEach(() => {
    checker = new HealthChecker({
      httpServerUrl: 'http://localhost:18080',
      criticalCooldown: 10000,
      warningThrottle: 0.5,
    });
  });

  describe('canSendRequest', () => {
    it('allows requests by default', () => {
      const result = checker.canSendRequest();
      assert.equal(result.allowed, true);
    });

    it('blocks during circuit breaker', () => {
      checker.circuitBreakerUntil = Date.now() + 60000;
      const result = checker.canSendRequest();
      assert.equal(result.allowed, false);
      assert.ok(result.retryAfter > 0);
    });

    it('allows with throttle hint in warning state', () => {
      checker.currentStatus = 'warning';
      const result = checker.canSendRequest();
      assert.equal(result.allowed, true);
      assert.equal(result.throttle, 0.5);
    });
  });

  describe('getStatus', () => {
    it('reports initial state', () => {
      const status = checker.getStatus();
      assert.equal(status.status, 'unknown');
      assert.equal(status.lastCheck, null);
      assert.equal(status.isCircuitBreakerOpen, false);
      assert.equal(status.consecutiveFailures, 0);
    });
  });

  describe('resetCircuitBreaker', () => {
    it('clears breaker state', () => {
      checker.circuitBreakerUntil = Date.now() + 60000;
      checker.consecutiveFailures = 5;
      checker.resetCircuitBreaker();

      assert.equal(checker.circuitBreakerUntil, 0);
      assert.equal(checker.consecutiveFailures, 0);
      assert.equal(checker.canSendRequest().allowed, true);
    });
  });

  describe('updateConfig', () => {
    it('updates configuration fields', () => {
      checker.updateConfig({ httpServerUrl: 'http://new:9090', timeout: 10000 });
      assert.equal(checker.httpServerUrl, 'http://new:9090');
      assert.equal(checker.timeout, 10000);
    });
  });
});
