# JobDB Feature Documentation

## Overview

The `jobDB` feature replaces the previous `processed_job_ids.log` functionality with a more sophisticated system that prevents duplicate processing of jobs by matching company and title combinations with timestamp-based expiration.

## Features

- **Company + Title Matching**: Prevents duplicate processing by matching both company name and job title (case-insensitive)
- **Automatic Expiration**: Jobs automatically expire after 7 days by default
- **JSON Storage**: Uses a JSON file-based database for better structure and queryability
- **CLI Control**: Can be enabled/disabled via the `--use-jobdb` flag
- **Automatic Cleanup**: Automatically removes expired entries at startup

## Configuration

### CLI Flag
```bash
# Enable jobDB (default)
jobJudge --use-jobdb

# Disable jobDB
jobJudge --no-use-jobdb
```

### Database File Location
- **File**: `data/jobDB.json`
- **Format**: JSON array of job entries
- **Auto-created**: The file and directory are created automatically on first use

### Default Expiration
- **Duration**: 7 days (604,800,000 milliseconds)
- **Configurable**: Can be modified in the JobDB class constructor

## Database Schema

Each entry in the jobDB contains:

```json
{
  "linkedInJobId": "1234567890",
  "company": "Tech Corp",
  "title": "Software Engineer",
  "admitTime": 1640995200000,
  "lastProcessed": 1640995200000
}
```

### Field Descriptions
- `linkedInJobId`: LinkedIn job identifier (extracted from URL if needed)
- `company`: Company name (normalized to lowercase, trimmed)
- `title`: Job title (normalized to lowercase, trimmed)
- `admitTime`: Unix timestamp (milliseconds) when job was first added
- `lastProcessed`: Unix timestamp (milliseconds) when job was last processed

## Workflow

### 1. Startup
- Initialize jobDB database
- Load existing entries from `data/jobDB.json`
- Clean up expired entries (older than 7 days)

### 2. Job Processing
- For each job in the input batch:
  - Check if job matches any entry in jobDB (company + title)
  - If match found, skip job and move to duplicates directory
  - If no match, process job normally

### 3. After Processing
- Add successfully processed jobs to jobDB
- Save updated database to file

### 4. Expiration
- Jobs older than 7 days are automatically removed
- Cleanup occurs at startup before processing begins

## Migration from processed_job_ids.log

The jobDB system is designed to be a drop-in replacement for the previous `processed_job_ids.log` system. The key differences:

### Old System
- Stored only LinkedIn job IDs
- Permanent storage (no expiration)
- Exact ID matching only
- Simple text file format

### New System
- Stores LinkedIn job ID, company, title, and timestamps
- Automatic expiration after 7 days
- Company + title matching (more flexible)
- JSON format for better structure
- Rich statistics and metadata

## API Reference

### JobDB Class

#### Constructor
```typescript
new JobDB(config: JobDBConfig)
```

#### Methods
- `initialize()`: Initialize database directory
- `load()`: Load database from file
- `save()`: Save database to file
- `cleanupExpired()`: Remove expired entries
- `isJobMatched(job, excludeId?)`: Check if job matches database
- `addJob(job, linkedInJobId?)`: Add job to database
- `removeJob(linkedInJobId)`: Remove job from database
- `size()`: Get database entry count
- `getAllEntries()`: Get all database entries
- `getStats()`: Get database statistics

### JobDBConfig Interface
```typescript
interface JobDBConfig {
  dbFilePath: string;        // Path to JSON database file
  defaultExpirationMs: number; // Expiration duration in milliseconds
  enableJobDB: boolean;      // Enable/disable functionality
}
```

## Error Handling

The jobDB system includes comprehensive error handling:

- **File System Errors**: Graceful handling of file read/write errors
- **Invalid JSON**: Proper error handling for corrupted database files
- **Permission Issues**: Appropriate error messages for file permission problems
- **Missing Directories**: Automatic creation of required directories

## Performance Considerations

- **Memory Usage**: Database is loaded into memory for fast lookups
- **File I/O**: Minimal file operations (load once at startup, save on changes)
- **Matching Algorithm**: Case-insensitive string comparison with normalization
- **Cleanup**: Efficient removal of expired entries during startup

## Testing

Run the jobDB tests with:
```bash
npx ts-node test/jobDB.test.ts
```

The test suite covers:
- Database initialization and file operations
- Load/save functionality
- Expiration and cleanup
- Job matching logic
- Error handling scenarios
- Disabled mode behavior

## Troubleshooting

### Common Issues

1. **Database File Corrupted**
   - Delete `data/jobDB.json` and restart
   - The system will create a fresh database

2. **Permission Denied**
   - Ensure write permissions for `data/` directory
   - Check file ownership if applicable

3. **Jobs Not Being Skipped**
   - Verify `--use-jobdb` flag is enabled (default: true)
   - Check that company and title matching is working as expected
   - Ensure job entries have proper company and title fields

### Debug Mode

Enable verbose logging to troubleshoot jobDB operations:
```bash
jobJudge --use-jobdb --verbose
```

## Future Enhancements

Potential future improvements:
- Configurable expiration periods
- Multiple database backends (SQLite, etc.)
- Remote database support
- Enhanced matching rules
- Database export/import utilities
- Performance optimizations for large datasets