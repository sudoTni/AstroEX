# Logging Migration Guide

This guide explains how to migrate from the existing logging system to the enhanced logging utilities in AstroEX.

## Overview

The enhanced logging system provides:
- Structured logging with correlation IDs
- Consistent log levels and formatting
- Performance monitoring
- Better error context
- Decorators for automatic performance tracking

## Key Improvements

### 1. Correlation IDs
- Automatically generated for each operation
- Helps track requests across multiple services
- Can be manually set for specific operations

### 2. Log Levels
- DEBUG: Detailed debugging information
- INFO: General information about application flow
- WARN: Warning messages that don't stop execution
- ERROR: Error messages that indicate failures

### 3. Performance Monitoring
- Built-in timing for operations
- Automatic performance logging
- Decorators for method-level tracking

## Migration Steps

### Step 1: Import Enhanced Logging

```typescript
// Replace this:
import { log } from './utils';

// With this:
import { createLogger, LogLevel, configureLogging } from './utils';
```

### Step 2: Create Module Logger

```typescript
// Replace this:
log("ModuleName", "Message", "info", { context });

// With this:
const logger = createLogger("ModuleName");
logger.info("Message", { context });
```

### Step 3: Use Enhanced Logging Functions

```typescript
// Replace this:
log("ModuleName", "Operation started", "info");
// ... operation code ...
log("ModuleName", "Operation completed", "info");

// With this:
const logger = createLogger("ModuleName");
logger.info("Operation started");
// ... operation code ...
logger.info("Operation completed");
```

### Step 4: Add Correlation IDs

```typescript
// Set correlation ID for tracking
setContext({ correlationId: "12345", userId: "user123" });

// Use in all related logs
logger.info("Starting operation", { correlationId: "12345" });
```

### Step 5: Performance Monitoring

```typescript
// Manual performance tracking
const startTime = performance.now();
// ... operation code ...
logger.performance("Operation name", startTime);

// Or use the decorator (for class methods)
@logPerformance("ModuleName")
async myMethod() {
  // Method implementation
}
```

### Step 6: Error Logging with Context

```typescript
// Replace this:
log("ModuleName", `Error: ${error.message}`, "error", { error });

// With this:
logger.error("Operation failed", { error, stack: error.stack });
```

## Migration Examples

### Before
```typescript
import { log } from './utils';

export class LLMService {
  async call(request: LLMRequest): Promise<LLMResponse> {
    log("LLMService", `Making LLM call to ${request.provider}/${request.model}`, "info", {
      provider: request.provider,
      model: request.model,
    });
    
    try {
      // ... operation code ...
      log("LLMService", "LLM call completed successfully", "info");
      return result;
    } catch (error) {
      log("LLMService", `LLM call failed: ${error.message}`, "error");
      throw error;
    }
  }
}
```

### After
```typescript
import { createLogger, withLogging, setContext } from './utils';

export class LLMService {
  private logger = createLogger("LLMService");

  async call(request: LLMRequest): Promise<LLMResponse> {
    // Set correlation ID for this request
    setContext({ correlationId: request.id, userId: request.userId });
    
    this.logger.info(`Making LLM call to ${request.provider}/${request.model}`, {
      provider: request.provider,
      model: request.model,
    });
    
    return withLogging(
      this.logger,
      "LLM call",
      async () => {
        // ... operation code ...
        this.logger.info("LLM call completed successfully");
        return result;
      },
      { correlationId: request.id }
    );
  }
}
```

## Configuration

### Global Logging Configuration

```typescript
import { configureLogging, LogLevel } from './utils';

// Configure logging globally
configureLogging({
  level: LogLevel.DEBUG, // Minimum log level to show
  enableConsole: true,
  enableFile: true,
  enableStructured: true,
  correlationIdGenerator: () => `correlation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
});
```

### Environment Variables

Set these environment variables to control logging behavior:

```bash
# Set minimum log level
LOG_LEVEL=debug

# Disable console output
NO_CONSOLE_LOG=true

# Disable file logging
NO_FILE_LOG=true

# Disable structured logging
NO_STRUCTURED_LOG=true
```

## Best Practices

### 1. Use Module-Level Loggers
Create a logger instance for each module to maintain consistent prefixes.

```typescript
// utils/logger.ts
export const logger = createLogger("Utils");
```

### 2. Use Context for Correlation
Always include correlation IDs when tracking operations across services.

```typescript
setContext({ correlationId: operationId, traceId: traceId });
```

### 3. Log Performance Metrics
Log performance for critical operations to identify bottlenecks.

```typescript
const startTime = performance.now();
// ... operation ...
logger.performance("Operation name", startTime);
```

### 4. Use Appropriate Log Levels
- DEBUG: Detailed debugging information (development only)
- INFO: General information about application flow
- WARN: Warning messages that don't stop execution
- ERROR: Error messages that indicate failures

### 5. Include Relevant Context
Always include relevant context in log messages to help with debugging.

```typescript
logger.error("Operation failed", { 
  error: error.message,
  stack: error.stack,
  correlationId: getCurrentContext().correlationId
});
```

## Troubleshooting

### Common Issues

1. **Import Errors**: Make sure you're importing from the correct path: `./utils`

2. **Log Level Not Showing**: Check the global log level configuration

3. **Correlation IDs Not Working**: Make sure to call `setContext()` before logging

4. **Performance Logging Not Working**: Ensure you're using the correct timing functions

### Debug Mode

Enable debug logging to see detailed information:

```typescript
configureLogging({ level: LogLevel.DEBUG });
```

## Testing

Test your logging implementation by:

1. Verifying log levels are working correctly
2. Checking that correlation IDs are being tracked
3. Confirming performance metrics are being logged
4. Testing error logging with proper context

## Migration Checklist

- [ ] Import enhanced logging utilities
- [ ] Create module-level loggers
- [ ] Replace existing log calls with enhanced logging
- [ ] Add correlation IDs for tracking
- [ ] Implement performance monitoring
- [ ] Update error logging with proper context
- [ ] Configure global logging settings
- [ ] Test logging functionality
- [ ] Remove old logging imports (after complete migration)