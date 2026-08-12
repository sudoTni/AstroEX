# Max-Tokens CLI Override Feature

## Overview

This document describes the enhanced max-tokens handling functionality implemented in AstroEX version 3.4.3, which allows CLI `--max-tokens` arguments to properly override `maxTokens` values defined within presets across all modes consistently.

## Key Features

### CLI Argument Override
- **Priority**: CLI arguments now take precedence over preset values
- **Fallback**: Preset values are used when no CLI argument is provided
- **Default**: System default (8000) is used when neither CLI nor preset values are available

### Eliminated Hardcoded Values
- All hardcoded `max-tokens` values have been removed from the codebase
- Consistent default value of 8000 across all commands
- Improved maintainability and flexibility

## Implementation Details

### Override Logic Pattern
The implemented pattern ensures proper precedence:

```typescript
// CLI argument → Preset value → Default fallback
maxTokens: typedArgv["max-tokens"] as number ?? effectivePreset.maxTokens ?? 8000
```

### Affected Commands
1. **jobCloth**: Updated to use CLI argument override pattern
2. **jobJudge**: Enhanced with proper preset fallback logic and CLI override capability (FIXED)
3. **makeMaterials**: Implemented CLI argument precedence
4. **er44zzModes**: Removed hardcoded values, added CLI support

### Recent Improvements (Version 3.4.3)
- **Consistency Fix**: Fixed `jobJudge` mode to properly support CLI override of preset `maxTokens` values
- **Standardized Pattern**: All modes now use the same pattern: `maxTokens: CLI ?? preset ?? 8000`
- **Enhanced Validation**: Improved error handling and validation across all modes
- **Comprehensive Testing**: Added test suite to verify consistency across all modes

### Files Modified
- `src/commands/jobCloth.ts`: Updated max-tokens handling
- `src/commands/jobJudge.ts`: Enhanced override logic
- `src/commands/makeMaterials.ts`: Implemented CLI argument support
- `src/commands/er44zzModes.ts`: Removed hardcoded values
- `src/jobDB.ts`: Fixed TypeScript compilation issues
- `src/types/enhanced.ts`: Resolved linting issues

## Usage Examples

### Basic Usage
```bash
# Use preset max-tokens
jobJudge --preset jep_ds-v3-0324

# Override max-tokens via CLI
jobJudge --preset jep_ds-v3-0324 --max-tokens 4000

# Use default max-tokens (8000)
jobJudge --preset jep_ds-v3-0324 --max-tokens
```

### Advanced Usage
```bash
# Override max-tokens for different commands
jobCloth --preset jc_mai-ds-r1 --max-tokens 6000
makeMaterials --preset rop_z-glma --max-tokens 12000
er44zzModes --preset resume --max-tokens 3000
```

## Configuration

### Preset Configuration
The `max-tokens` values in presets.json remain the baseline configuration:

```json
{
  "jobJudge": {
    "jep_ds-v3-0324": {
      "maxTokens": 8000,
      "temperature": 0.60,
      "topP": 0.95,
      "provider": "openrouter",
      "modelId": "deepseek/deepseek-chat-v3-0324:free"
    }
  }
}
```

### CLI Arguments
- **Flag**: `--max-tokens`
- **Type**: Number
- **Priority**: Highest (overrides presets)
- **Validation**: Must be between 1 and 32000 tokens

## Technical Specifications

### Validation Rules
- **Minimum**: 1 token
- **Maximum**: 32000 tokens (based on LLM provider limits)
- **Default**: 8000 tokens
- **Type**: Strict number validation

### Error Handling
- Invalid `--max-tokens` values will trigger validation errors
- Missing values fall back to preset defaults
- All errors are logged with clear messaging

### Performance Impact
- **Minimal**: No performance degradation introduced
- **Efficient**: Boolean checks for CLI argument presence
- **Cached**: Preset values are loaded once per command execution

## Migration Guide

### From Previous Versions
If you were previously relying on hardcoded max-tokens values:

1. **Update CLI Commands**: Add `--max-tokens` flag where needed
2. **Configure Presets**: Set appropriate max-tokens values in presets.json
3. **Test Override**: Verify CLI arguments properly override presets

### Breaking Changes
- **None**: This is a backward-compatible enhancement
- **Deprecation**: No deprecated functionality removed
- **Migration**: Zero migration required for existing users

## Testing

### Unit Tests
```bash
# Run all tests
npm test

# Test max-tokens functionality specifically
npm test -- --grep "max-tokens"
```

### Integration Tests
```bash
# Test CLI override functionality
npm run test:integration:max-tokens

# Test preset fallback behavior
npm run test:integration:preset-fallback
```

### Manual Testing
1. Verify CLI `--max-tokens` overrides preset values
2. Confirm preset values are used when no CLI argument provided
3. Ensure default fallback works when neither is specified
4. Test error handling for invalid values

## Troubleshooting

### Common Issues

1. **CLI Argument Not Overriding Preset**
   - Verify flag syntax: `--max-tokens 4000` (not `--max-tokens=4000`)
   - Check for typos in flag name
   - Ensure command supports the flag

2. **Invalid Token Values**
   - Values must be between 1 and 32000
   - Must be a valid number (not string)
   - Check for whitespace in the value

3. **Default Value Not Applied**
   - Verify preset configuration is valid
   - Check presets.json file permissions
   - Ensure preset name is correct

### Debug Mode
Enable verbose logging to troubleshoot max-tokens handling:
```bash
jobJudge --preset jep_ds-v3-0324 --max-tokens 4000 --verbose
```

## Future Enhancements

### Planned Improvements
1. **Dynamic Validation**: Provider-specific max-tokens limits
2. **Batch Processing**: Different max-tokens for different job types
3. **Auto-tuning**: AI-optimized max-tokens selection
4. **Analytics**: Usage statistics and recommendations

### Version Compatibility
- **Current**: 3.4.3
- **Minimum**: 3.2.0
- **Recommended**: Latest stable version

### Recent Fixes (2025-10-04)
- **Issue**: `maxTokens` functionality was not consistent across all modes
- **Root Cause**: `jobJudge` mode lacked CLI override capability
- **Solution**: Updated `jobJudge` to use the same pattern as other modes
- **Impact**: All modes now consistently support CLI override of preset `maxTokens` values

## Support

For issues or questions regarding max-tokens functionality:
1. Check this documentation
2. Review troubleshooting section
3. Run with `--verbose` flag for detailed logging
4. Consult preset configuration examples

---

**Version**: 3.4.3
**Last Updated**: 2025-10-04
**Status**: Production Ready