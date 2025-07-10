// Polyfill for randomUUID if crypto module is not available
const randomUUID = (() => {
  try {
    return require('crypto').randomUUID;
  } catch {
    // Fallback UUID generator for environments without crypto module
    return () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
  }
})();

// Types and Interfaces
interface EmailMessage {
  id?: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  timestamp?: Date;
}

interface EmailProvider {
  name: string;
  sendEmail(message: EmailMessage): Promise<EmailResult>;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  provider: string;
  timestamp: Date;
}

enum EmailStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  RETRYING = 'retrying',
  RATE_LIMITED = 'rate_limited'
}

interface EmailAttempt {
  id: string;
  message: EmailMessage;
  status: EmailStatus;
  attempts: number;
  maxAttempts: number;
  lastAttempt?: Date;
  nextAttempt?: Date;
  results: EmailResult[];
  createdAt: Date;
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  monitoringWindowMs: number;
}

enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

// Mock Email Providers
class MockEmailProvider implements EmailProvider {
  constructor(
    public name: string,
    private failureRate: number = 0.1,
    private avgResponseTime: number = 100
  ) {}

  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, this.avgResponseTime + Math.random() * 50));
    
    // Simulate random failures
    if (Math.random() < this.failureRate) {
      return {
        success: false,
        error: `${this.name} temporarily unavailable`,
        provider: this.name,
        timestamp: new Date()
      };
    }

    return {
      success: true,
      messageId: `${this.name}-${randomUUID()}`,
      provider: this.name,
      timestamp: new Date()
    };
  }
}

// Circuit Breaker Implementation
class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures: number = 0;
  private lastFailureTime: Date | null = null;
  private successCount: number = 0;

  constructor(private config: CircuitBreakerConfig) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private shouldAttemptReset(): boolean {
    return this.lastFailureTime !== null &&
           Date.now() - this.lastFailureTime.getTime() > this.config.resetTimeoutMs;
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= 3) { // Require 3 successful calls to close
        this.state = CircuitBreakerState.CLOSED;
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = new Date();
    
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.OPEN;
    } else if (this.failures >= this.config.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
    }
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getStats() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      successCount: this.successCount
    };
  }
}

// Rate Limiter Implementation
class RateLimiter {
  private requests: Map<string, number[]> = new Map();

  constructor(private config: RateLimitConfig) {}

  canProceed(key: string = 'default'): boolean {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    const timestamps = this.requests.get(key)!;
    
    // Remove old requests outside the window
    const validRequests = timestamps.filter(timestamp => timestamp > windowStart);
    this.requests.set(key, validRequests);

    // Check if we can add another request
    if (validRequests.length < this.config.maxRequests) {
      validRequests.push(now);
      return true;
    }

    return false;
  }

  getStats(key: string = 'default') {
    const timestamps = this.requests.get(key) || [];
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const validRequests = timestamps.filter(timestamp => timestamp > windowStart);
    
    return {
      currentRequests: validRequests.length,
      maxRequests: this.config.maxRequests,
      windowMs: this.config.windowMs,
      resetTime: validRequests.length > 0 ? new Date(validRequests[0] + this.config.windowMs) : null
    };
  }
}

// Simple Logger
class Logger {
  static info(message: string, data?: any): void {
    console.log(`[INFO] ${new Date().toISOString()}: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  static error(message: string, error?: any): void {
    console.error(`[ERROR] ${new Date().toISOString()}: ${message}`, error);
  }

  static warn(message: string, data?: any): void {
    console.warn(`[WARN] ${new Date().toISOString()}: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }
}

// Simple Queue System
class EmailQueue {
  private queue: EmailAttempt[] = [];
  private processing: boolean = false;

  add(attempt: EmailAttempt): void {
    this.queue.push(attempt);
    if (!this.processing) {
      this.process();
    }
  }

  private async process(): Promise<void> {
    this.processing = true;
    
    while (this.queue.length > 0) {
      const attempt = this.queue.shift()!;
      
      // Check if it's time to retry
      if (attempt.nextAttempt && attempt.nextAttempt > new Date()) {
        this.queue.push(attempt); // Re-queue for later
        continue;
      }

      try {
        await this.processAttempt(attempt);
      } catch (error) {
        Logger.error('Error processing email attempt', error);
      }
    }
    
    this.processing = false;
  }

  private async processAttempt(attempt: EmailAttempt): Promise<void> {
    // This would be implemented by the EmailService
    // For now, just log that we're processing
    Logger.info(`Processing email attempt: ${attempt.id}`);
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      processing: this.processing
    };
  }
}

// Main EmailService Implementation
class EmailService {
  private providers: EmailProvider[] = [];
  private attempts: Map<string, EmailAttempt> = new Map();
  private idempotencyKeys: Set<string> = new Set();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private rateLimiter: RateLimiter;
  private queue: EmailQueue;

  constructor(
    private retryConfig: RetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2
    },
    private rateLimitConfig: RateLimitConfig = {
      maxRequests: 100,
      windowMs: 60000 // 1 minute
    },
    private circuitBreakerConfig: CircuitBreakerConfig = {
      failureThreshold: 5,
      resetTimeoutMs: 60000,
      monitoringWindowMs: 300000
    }
  ) {
    this.rateLimiter = new RateLimiter(rateLimitConfig);
    this.queue = new EmailQueue();
  }

  addProvider(provider: EmailProvider): void {
    this.providers.push(provider);
    this.circuitBreakers.set(provider.name, new CircuitBreaker(this.circuitBreakerConfig));
    Logger.info(`Added email provider: ${provider.name}`);
  }

  async sendEmail(message: EmailMessage, idempotencyKey?: string): Promise<string> {
    // Check idempotency
    if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
      Logger.warn(`Duplicate request detected for idempotency key: ${idempotencyKey}`);
      throw new Error('Duplicate request - email already sent or in progress');
    }

    // Check rate limiting
    if (!this.rateLimiter.canProceed()) {
      Logger.warn('Rate limit exceeded');
      throw new Error('Rate limit exceeded');
    }

    // Create email attempt
    const attemptId = randomUUID();
    const emailMessage = {
      ...message,
      id: message.id || randomUUID(),
      timestamp: new Date()
    };

    const attempt: EmailAttempt = {
      id: attemptId,
      message: emailMessage,
      status: EmailStatus.PENDING,
      attempts: 0,
      maxAttempts: this.retryConfig.maxAttempts,
      results: [],
      createdAt: new Date()
    };

    this.attempts.set(attemptId, attempt);
    
    if (idempotencyKey) {
      this.idempotencyKeys.add(idempotencyKey);
    }

    Logger.info(`Starting email send attempt: ${attemptId}`);

    try {
      await this.executeWithRetry(attempt);
      return attemptId;
    } catch (error) {
      attempt.status = EmailStatus.FAILED;
      Logger.error(`Email send failed: ${attemptId}`, error);
      throw error;
    }
  }

  private async executeWithRetry(attempt: EmailAttempt): Promise<void> {
    let lastError: Error | null = null;

    for (let i = 0; i < this.retryConfig.maxAttempts; i++) {
      attempt.attempts++;
      attempt.lastAttempt = new Date();
      attempt.status = i === 0 ? EmailStatus.PENDING : EmailStatus.RETRYING;

      try {
        const result = await this.tryAllProviders(attempt.message);
        attempt.results.push(result);
        
        if (result.success) {
          attempt.status = EmailStatus.SENT;
          Logger.info(`Email sent successfully: ${attempt.id}`, result);
          return;
        }

        lastError = new Error(result.error || 'Unknown error');
      } catch (error) {
        lastError = error as Error;
        Logger.error(`Attempt ${i + 1} failed for ${attempt.id}`, error);
      }

      // Calculate delay for next attempt
      if (i < this.retryConfig.maxAttempts - 1) {
        const delay = Math.min(
          this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, i),
          this.retryConfig.maxDelayMs
        );
        
        attempt.nextAttempt = new Date(Date.now() + delay);
        Logger.info(`Retrying in ${delay}ms for attempt ${attempt.id}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('Max retry attempts exceeded');
  }

  private async tryAllProviders(message: EmailMessage): Promise<EmailResult> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      const circuitBreaker = this.circuitBreakers.get(provider.name)!;
      
      try {
        const result = await circuitBreaker.execute(() => provider.sendEmail(message));
        if (result.success) {
          return result;
        }
        lastError = new Error(result.error || 'Provider failed');
      } catch (error) {
        lastError = error as Error;
        Logger.warn(`Provider ${provider.name} failed`, error);
      }
    }

    throw lastError || new Error('All providers failed');
  }

  getAttemptStatus(attemptId: string): EmailAttempt | null {
    return this.attempts.get(attemptId) || null;
  }

  getStats() {
    const attempts = Array.from(this.attempts.values());
    const statusCounts = attempts.reduce((acc, attempt) => {
      acc[attempt.status] = (acc[attempt.status] || 0) + 1;
      return acc;
    }, {} as Record<EmailStatus, number>);

    // Polyfill for Object.fromEntries (ES2019+)
    const objectFromEntries = (entries: [string, any][]) => {
      const result: any = {};
      for (const [key, value] of entries) {
        result[key] = value;
      }
      return result;
    };

    const circuitBreakerStats = objectFromEntries(
      Array.from(this.circuitBreakers.entries()).map(([name, cb]) => [name, cb.getStats()])
    );

    return {
      totalAttempts: attempts.length,
      statusCounts,
      rateLimitStats: this.rateLimiter.getStats(),
      circuitBreakerStats,
      queueStats: this.queue.getStats(),
      providers: this.providers.map(p => p.name)
    };
  }

  // Health check method
  async healthCheck(): Promise<{ healthy: boolean; details: any }> {
    const stats = this.getStats();
    // Polyfill for Object.entries (ES2017+)
    const objectEntries = (obj: any) => {
      return Object.keys(obj).map(key => [key, obj[key]]);
    };

    const unhealthyProviders = objectEntries(stats.circuitBreakerStats)
      .filter(([_, stats]) => (stats as any).state === CircuitBreakerState.OPEN)
      .map(([name, _]) => name);

    return {
      healthy: unhealthyProviders.length < this.providers.length,
      details: {
        ...stats,
        unhealthyProviders
      }
    };
  }
}

// Usage Example and Tests
class EmailServiceExample {
  static async run() {
    // Initialize service
    const emailService = new EmailService();

    // Add mock providers
    emailService.addProvider(new MockEmailProvider('SendGrid', 0.1, 100));
    emailService.addProvider(new MockEmailProvider('Mailgun', 0.15, 150));

    // Example email
    const email: EmailMessage = {
      to: 'user@example.com',
      from: 'noreply@company.com',
      subject: 'Test Email',
      body: 'This is a test email from our resilient email service.'
    };

    try {
      console.log('Sending email...');
      const attemptId = await emailService.sendEmail(email, 'unique-key-123');
      console.log(`Email attempt started: ${attemptId}`);

      // Check status
      const status = emailService.getAttemptStatus(attemptId);
      console.log('Email status:', status);

      // Get service stats
      const stats = emailService.getStats();
      console.log('Service stats:', stats);

      // Health check
      const health = await emailService.healthCheck();
      console.log('Health check:', health);

    } catch (error) {
      console.error('Error:', error);
    }
  }
}

// Simple test runner
class TestRunner {
  static async runTests() {
    console.log('Running Email Service Tests...\n');

    // Test 1: Basic email sending
    console.log('Test 1: Basic Email Sending');
    try {
      const service = new EmailService();
      service.addProvider(new MockEmailProvider('TestProvider', 0, 50));
      
      const email: EmailMessage = {
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        body: 'Test body'
      };

      const attemptId = await service.sendEmail(email);
      const attempt = service.getAttemptStatus(attemptId);
      
      console.log(`✓ Email sent successfully: ${attempt?.status === EmailStatus.SENT ? 'PASSED' : 'FAILED'}`);
    } catch (error) {
      console.log(`✗ Basic email test failed: ${error}`);
    }

    // Test 2: Idempotency
    console.log('\nTest 2: Idempotency');
    try {
      const service = new EmailService();
      service.addProvider(new MockEmailProvider('TestProvider', 0, 50));
      
      const email: EmailMessage = {
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        body: 'Test body'
      };

      await service.sendEmail(email, 'idempotency-key');
      
      try {
        await service.sendEmail(email, 'idempotency-key');
        console.log('✗ Idempotency test failed - duplicate allowed');
      } catch (error) {
        console.log('✓ Idempotency test passed - duplicate rejected');
      }
    } catch (error) {
      console.log(`✗ Idempotency test failed: ${error}`);
    }

    // Test 3: Rate limiting
    console.log('\nTest 3: Rate Limiting');
    try {
      const service = new EmailService(
        { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 },
        { maxRequests: 2, windowMs: 1000 }
      );
      service.addProvider(new MockEmailProvider('TestProvider', 0, 10));

      const email: EmailMessage = {
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        body: 'Test body'
      };

      await service.sendEmail(email);
      await service.sendEmail(email);
      
      try {
        await service.sendEmail(email);
        console.log('✗ Rate limiting test failed - third request allowed');
      } catch (error) {
        console.log('✓ Rate limiting test passed - third request blocked');
      }
    } catch (error) {
      console.log(`✗ Rate limiting test failed: ${error}`);
    }

    console.log('\nAll tests completed!');
  }
}

// Export for use
export {
  EmailService,
  EmailMessage,
  EmailProvider,
  EmailStatus,
  EmailAttempt,
  MockEmailProvider,
  Logger,
  EmailServiceExample,
  TestRunner
};

// Run example if this file is executed directly (Node.js environment)
declare const require: any;
declare const module: any;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  EmailServiceExample.run().then(() => {
    console.log('\n' + '='.repeat(50));
    return TestRunner.runTests();
  });
}