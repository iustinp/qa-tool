/**
 * Global rate limiter for vision API calls.
 */

class RateLimiter {
  constructor(config = {}) {
    this.minDelayMs = config.minDelayBetweenRequests ?? 500;
    this.maxRequestsPerMinute = config.maxRequestsPerMinute ?? 30;
    this.lastRequestTime = 0;
    this.requestTimestamps = [];
  }

  async acquire() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60000);

    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      const oldestRequest = this.requestTimestamps[0];
      const waitTime = 60000 - (now - oldestRequest) + 100;
      if (waitTime > 0) {
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }

    const now2 = Date.now();
    const timeSinceLastRequest = now2 - this.lastRequestTime;
    if (timeSinceLastRequest < this.minDelayMs) {
      await new Promise((r) => setTimeout(r, this.minDelayMs - timeSinceLastRequest));
    }

    this.lastRequestTime = Date.now();
    this.requestTimestamps.push(this.lastRequestTime);
  }
}

module.exports = { RateLimiter };
