/**
 * Job-material deployment automation (OpenRouter Edition).
 * 
 * This Google Apps Script reads AstroEX output artifacts from the specified Google Drive folder,
 * requesting that an LLM find a suitable destination email address, send the cover letter as the email
 * body with the resume attached if it finds one, transforms the AstroEX output artifacts into pre-made
 * Google Docs templates, and maintains a Google Sheet of progress. It's rad.
 *
 * Revised pipeline:
 * 1. Read structured markdown material files from SOURCE_FOLDER_ID.
 * 2. Parse JD/application metadata and cover-letter body.
 * 3. Consult centralized Google Sheet to ensure JD hasn't already been processed.
 * 4. Discover ranked, evidence-backed application routes AND fetch company HQ address via OpenRouter.
 * 5. Generate tailored resume and cover-letter Google Docs from templates using custom filenames if specified.
 * 6. Generate a third custom output Google Doc containing the LinkedIn posting URL.
 * 7. Create Gmail drafts (or auto-send) for ALL defensible routing addresses (comma-separated).
 * 8. Extract the final, fully-templated text from the Cover Letter Doc for the email body.
 * 9. Attach the generated resume PDF to the email.
 * 10. Log the dispatch event to a centralized Google Sheet (comma-separated statuses).
 * 11. Dual-Log execution events to the Apps Script console AND a per-run Google Doc log file.
 * 12. Annotate generated Drive files (including the LinkedIn file) with discovery evidence and candidate scoring.
 * 13. Move the source material file to PROCESSED_FOLDER_ID only when successful.
 * 14. Auto-spawn a continuation trigger if approaching the 5-minute execution limit.
 * 15. Auto-scan inbox for bounce-backs and surgically update granular spreadsheet statuses.
 */

// ============================================================================
// 🚀 EMAIL DISPATCH & LOGGING CONFIGURATION
// ============================================================================

// TRUE  = Automatically SEND the emails immediately upon generation.
// FALSE = ONLY CREATE DRAFTS in your Gmail folder for manual review.
const AUTO_SEND_EMAILS = true;

// Set to false to completely disable both drafting and sending emails.
const ENABLE_EMAIL_DISPATCH = true;

// Centralized logging configuration
const ENABLE_SPREADSHEET_LOGGING = true;
const ENABLE_DOC_LOGGING = true;
const DOC_LOG_FOLDER_ID = 'REDACTED_RESOURCE_ID';
const DOC_LOG_FILE_NAME_PREFIX = 'AstroEX-RunLog';
const DOC_LOG_FILE_TS_FORMAT = 'yyyyMMdd-HHmmss-SSS';
const CONTINUATION_TRIGGER_DELAY_MS = 1000 * 60;
const CONTINUATION_TRIGGER_GUARD_PROP = 'DEPLOY_CONTINUATION_TRIGGER_AT';
const CONTINUATION_TRIGGER_GUARD_WINDOW_MS = 10 * 60 * 1000;

// ============================================================================

/**
 * Script Property names.
 * Ensure ALL of these are set in your Apps Script Project Settings -> Script Properties.
 */
const SCRIPT_PROPERTIES = Object.freeze({
  SOURCE_FOLDER_ID: 'SOURCE_FOLDER_ID',
  TARGET_FOLDER_ID: 'TARGET_FOLDER_ID',
  PROCESSED_FOLDER_ID: 'PROCESSED_FOLDER_ID',
  RESUME_TEMPLATE_ID: 'RESUME_TEMPLATE_ID',
  COVER_LETTER_TEMPLATE_ID: 'COVER_LETTER_TEMPLATE_ID',
  OR_API_KEY: 'OR_API_KEY', // REPLACED: POE_API_KEY -> OR_API_KEY
  SPREADSHEET_LOG_ID: 'SPREADSHEET_LOG_ID',
  APPLICANT_NAME: 'APPLICANT_NAME',
  APPLICANT_EMAIL: 'APPLICANT_EMAIL'
});

/**
 * OpenRouter / LLM configuration.
 */
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'google/gemini-3.1-flash-lite';

/**
 * Routing policy.
 */
const APPLICATION_DRAFT_MODE = 'HAIL_MARY';

const APPLICATION_EMAIL_HIGH_SCORE = 85;
const APPLICATION_EMAIL_MEDIUM_SCORE = 65;
const APPLICATION_EMAIL_HAIL_MARY_SCORE = 45;
const APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE = 0.55;
const MAX_DISCOVERY_CANDIDATES_TO_LOG = 5;
const MAX_DISCOVERY_CANDIDATES_TO_ANNOTATE = 8;

/**
 * Execution & Validation Policies.
 */
const REQUIRE_DRAFT_SUCCESS_FOR_DRAFTABLE_EMAIL = true;
const STRICT_GMAIL_FROM_VALIDATION = false;
const PREFLIGHT_GMAIL_DRAFT_AUTH = true;
const MOVE_SOURCE_FILE_AFTER_SUCCESS = true;
const ANNOTATE_DRIVE_FILES_WITH_DISCOVERY = true;
const ATTACH_RESUME_PDF = true;
const REUSE_EXISTING_GENERATED_FILES = true;
const REQUIRE_EMAIL_DISCOVERY_SUCCESS_WHEN_DRAFTING = true;
const REQUIRE_TEMPLATE_PLACEHOLDER_COMPLETION = true;
const INCLUDE_VISIBLE_JOB_URL_IN_RESUME = false;
const VISIBLE_JOB_URL_LABEL = 'Job posting';
const STRIP_LINKEDIN_FROM_RESUME_HEADER = false;
const LOG_STATUS_NO_DRAFTABLE_ROUTE = 'NO_DRAFTABLE_ROUTE';
const LOG_STATUS_DISPATCH_FAILED = 'DISPATCH_FAILED';
const LOG_STATUS_SUPPRESSED_BOUNCE = 'SUPPRESSED_BOUNCE';
const LOG_EMAIL_TIER_NO_DRAFTABLE_ROUTE = 'NO_DRAFTABLE_ROUTE';
const LOG_EMAIL_TIER_DISPATCH_FAILED = 'DISPATCH_FAILED';
const LOG_EMAIL_TIER_SUPPRESSED_BOUNCE = 'SUPPRESSED';

/**
 * Canonical placeholder names expected in the templates.
 */
const TEMPLATE_PLACEHOLDERS = Object.freeze({
  CUSTOM_PROF_TITLE: '{{custom_prof_title}}',
  CUSTOM_PROF_SUMMARY: '{{custom_prof_summary}}',
  CUSTOM_SKILLS: '{{custom_skills}}',
  JOB_URL: '{{job_url}}',
  TODAYS_DATE: '{{todays_date}}',
  JOB_COMPANY_ADDRESS: '{{job_company_address}}',
  JOB_COMPANY: '{{job_company}}',
  COVER_BODY: '{{cover_body}}'
});

/**
 * Global Regex Patterns (Instantiated once for memory efficiency)
 */
const LINKEDIN_PATTERNS = [
  '\\s*[•|]\\s*https*://[w.]*linkedin\\.com/[^ •|\\n]+\\s*[•|]?\\s*',
  '\\s*https*://[w.]*linkedin\\.com/[^ •|\\n]+\\s*[•|]?\\s*',
  '\\s*[•|]?\\s*[w.]*linkedin\\.com/[^ •|\\n]+\\s*[•|]?\\s*',
  '\\s*[•|]?\\s*LinkedIn\\s*[•|]?\\s*'
];

const SEPARATOR_PATTERNS =[
  { search: '\\s*[•|]\\s*[•|]\\s*', replace: ' • ' },
  { search: '^\\s*[•|]\\s*', replace: '' },
  { search: '\\s*[•|]\\s*$', replace: '' },
  { search: '^\\s+', replace: '' },
  { search: '\\s+$', replace: '' }
];

/**
 * Discovery tiers & actions.
 */
const DISCOVERY_TIERS = Object.freeze({
  OFFICIAL_APPLICATION_INTAKE: 'OFFICIAL_APPLICATION_INTAKE',
  OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT: 'OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT',
  OFFICIAL_GENERAL_CONTACT: 'OFFICIAL_GENERAL_CONTACT',
  PUBLIC_RECRUITER_OR_HIRING_TEAM: 'PUBLIC_RECRUITER_OR_HIRING_TEAM',
  OTHER_PUBLIC_ROUTE: 'OTHER_PUBLIC_ROUTE',
  SUPPRESSED: 'SUPPRESSED'
});

const DISCOVERY_ACTIONS = Object.freeze({
  CREATE_DRAFT: 'create_draft',
  BACKUP_ONLY: 'backup_only',
  SUPPRESS: 'suppress'
});

// ============================================================================
// 💾 IN-MEMORY CACHE FOR GOOGLE APIS
// ============================================================================
let CACHED_GMAIL_ALIASES = null;
let CACHED_EFFECTIVE_USER_EMAIL = null;
let CACHED_BOUNCED_ADDRESS_SET = null;

// ============================================================================
// 📝 CUSTOM DUAL-LOGGING SYSTEM
// ============================================================================

const SCRIPT_LOG_BUFFER =[];
const DOC_LOG_RUN_MARKER_PREFIX = '[DOC_RUN_START]';
const DOC_LOG_CURRENT_RUN_TIMESTAMP = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', DOC_LOG_FILE_TS_FORMAT);
const DOC_LOG_CURRENT_RUN_ID = Utilities.getUuid();
const DOC_LOG_CURRENT_RUN_MARKER = `${DOC_LOG_RUN_MARKER_PREFIX} ${DOC_LOG_CURRENT_RUN_TIMESTAMP} | ${DOC_LOG_CURRENT_RUN_ID}`;
let DOC_LOG_RUN_MARKER_WRITTEN = false;
let DOC_LOG_CURRENT_RUN_DOC_ID = '';
let DOC_LOG_CURRENT_RUN_DOC_NAME = '';

/**
 * Verbose Logger: Writes to console and pushes to Doc buffer.
 */
function vLog(message) {
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd HH:mm:ss.SSS');
  const formattedMessage = `[${timestamp}] ${message}`;
  Logger.log(formattedMessage);
  SCRIPT_LOG_BUFFER.push(formattedMessage);
}

function getOrCreateRunDocLogTarget() {
  if (DOC_LOG_CURRENT_RUN_DOC_ID) return DOC_LOG_CURRENT_RUN_DOC_ID;
  if (!DOC_LOG_FOLDER_ID) {
    throw new Error('DOC_LOG_FOLDER_ID is empty. Configure it in EMAIL DISPATCH & LOGGING CONFIGURATION.');
  }

  const folder = DriveApp.getFolderById(DOC_LOG_FOLDER_ID);
  DOC_LOG_CURRENT_RUN_DOC_NAME = `${DOC_LOG_FILE_NAME_PREFIX}-${DOC_LOG_CURRENT_RUN_TIMESTAMP}-${DOC_LOG_CURRENT_RUN_ID}`;
  const doc = DocumentApp.create(DOC_LOG_CURRENT_RUN_DOC_NAME);
  DOC_LOG_CURRENT_RUN_DOC_ID = doc.getId();
  const file = DriveApp.getFileById(DOC_LOG_CURRENT_RUN_DOC_ID);
  file.moveTo(folder);

  return DOC_LOG_CURRENT_RUN_DOC_ID;
}

/**
 * Flushes the accumulated log buffer to the current run's Google Doc.
 */
function flushDocLogs() {
  if (!ENABLE_DOC_LOGGING || SCRIPT_LOG_BUFFER.length === 0) return;
  try {
    const docId = getOrCreateRunDocLogTarget();
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();
    let textToAppend = '';
    if (!DOC_LOG_RUN_MARKER_WRITTEN) {
      textToAppend += `${DOC_LOG_CURRENT_RUN_MARKER}\n`;
      DOC_LOG_RUN_MARKER_WRITTEN = true;
    }
    textToAppend += SCRIPT_LOG_BUFFER.join('\n') + '\n';
    
    body.appendParagraph(textToAppend);
    SCRIPT_LOG_BUFFER.length = 0; // Clear buffer after successful write

    Logger.log(`[SUCCESS] Flushed logs to run Google Doc (${docId}) "${DOC_LOG_CURRENT_RUN_DOC_NAME}".`);
  } catch (e) {
    Logger.log(`[ERROR] Failed to flush logs to Google Doc: ${e.message}`);
  }
}

// ============================================================================

/**
 * One-time helper. Run manually after adding Gmail scopes if authorization is stale.
 */
function authorizeGmailDrafting() {
  vLog('[AUTH] Requesting required configurations for Gmail authorization flow...');
  const config = getRequiredDeploymentConfig();
  vLog('[AUTH] Creating authorization test draft...');
  GmailApp.createDraft(config.applicantEmail, 'Apps Script Gmail Draft Authorization Test', 'This draft was created to authorize Gmail draft permissions. You may delete it.');
  vLog('[AUTH] Authorization test draft created successfully. You may delete it from Gmail.');
  flushDocLogs();
}

/**
 * Performs an early Gmail authorization check. Uses CacheService to prevent redundant API calls.
 */
function preflightGmailDraftAuthorization(config) {
  vLog('[PREFLIGHT] Running Gmail preflight authorization check...');
  if (!PREFLIGHT_GMAIL_DRAFT_AUTH || !ENABLE_EMAIL_DISPATCH || APPLICATION_DRAFT_MODE === 'OFF') {
    vLog('[PREFLIGHT] Gmail preflight skipped based on configuration flags.');
    return;
  }

  const cache = CacheService.getScriptCache();
  if (cache.get('gmail_auth_ok')) {
    vLog('[PREFLIGHT] Gmail preflight: Authorization status found in memory cache. Status: OK.');
    return;
  }

  if (STRICT_GMAIL_FROM_VALIDATION) {
    if (!canUseGmailFromAddress(config.applicantEmail)) {
      const aliases = getNormalizedGmailAliases();
      throw new Error(
        `Configured APPLICANT_EMAIL (${config.applicantEmail}) is not authorized as a Gmail From address. ` +
        `Add it as a verified alias or disable STRICT_GMAIL_FROM_VALIDATION. Known aliases: ${aliases.join(', ') || 'NONE'}`
      );
    }
    vLog(`[PREFLIGHT] Strict From-address validation passed for: ${config.applicantEmail}`);
  }

  let draft = null;
  try {
    vLog('[PREFLIGHT] Generating tentative test draft payload...');
    draft = GmailApp.createDraft(
      config.applicantEmail,
      'Apps Script Gmail Draft Preflight',
      'Temporary authorization preflight draft. This draft should be deleted automatically.'
    );
    vLog('  - [PREFLIGHT] Gmail preflight: Gmail draft generation is authorized.');

    try {
      draft.deleteDraft();
      cache.put('gmail_auth_ok', 'true', 21600); // Cache success for 6 hours
      vLog('  - [PREFLIGHT] temporary preflight draft removed and status successfully cached.');
    } catch (deleteError) {
      vLog(`  - [PREFLIGHT] Notice: Preflight draft could not be automatically deleted: ${deleteError.message}`);
    }
  } catch (e) {
    vLog(`  - [PREFLIGHT] [WARNING] Gmail preflight authorization failed: ${e.message}`);
  }
}

/**
 * Performs an early Spreadsheet authorization check.
 */
function preflightSpreadsheetAuthorization(config) {
  vLog('[PREFLIGHT] Running Spreadsheet preflight authorization check...');
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('[PREFLIGHT] Spreadsheet preflight skipped based on configuration.');
    return;
  }
  try {
    vLog(`[PREFLIGHT] Attempting connection check to sheet ID: ${config.spreadsheetLogId}`);
    SpreadsheetApp.openById(config.spreadsheetLogId);
    vLog(`  - [PREFLIGHT] Spreadsheet preflight: Spreadsheet access is verified.`);
  } catch (e) {
    vLog(`  - [PREFLIGHT] [WARNING] Spreadsheet access check failed: ${e.message}`);
  }
}

/**
 * Scans the Gmail inbox for bounce-backs (Delivery Status Notifications)
 * and surgically updates the corresponding comma-separated entries in the Spreadsheet log to 'BOUNCED'.
 */
function scanForBounces(config) {
  vLog('[BOUNCE TRACKER] Initiating search for standard mailer bounce indicators...');
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('  - [BOUNCE TRACKER] Spreadsheet logging disabled. Skipping bounce scan.');
    return;
  }

  try {
    const sheet = SpreadsheetApp.openById(config.spreadsheetLogId).getSheets()[0];
    const lastRow = sheet.getLastRow();
    vLog(`  - [BOUNCE TRACKER] Logging Sheet has ${lastRow} total rows.`);
    
    if (lastRow <= 1) {
      vLog('  - [BOUNCE TRACKER] Spreadsheet contains only header elements. Skipping bounce scan.');
      return;
    }

    // Fetch relevant columns (Status is Col 2, Job ID is Col 4, Job Title is Col 5, Target Email is Col 6)
    const data = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
    const sentJobs =[];

    for (let i = 0; i < data.length; i++) {
      const statusStr = String(data[i][1] || '').trim().toUpperCase();
      const emailStr = String(data[i][5] || '').trim().toLowerCase();
      
      const statuses = statusStr.split(',').map(s => s.trim());
      const emails = emailStr.split(',').map(e => e.trim());

      // Only track jobs that have at least one active SENT status
      if (statuses.includes('SENT')) {
        sentJobs.push({
          rowIndex: i + 2,
          jobId: String(data[i][3] || '').trim().toLowerCase(),
          jobTitle: String(data[i][4] || '').trim().toLowerCase(),
          emails: emails,
          statuses: statuses
        });
      }
    }

    vLog(`  - [BOUNCE TRACKER] Loaded ${sentJobs.length} potential tracking records currently set to "SENT".`);
    if (sentJobs.length === 0) {
      vLog('  - [BOUNCE TRACKER] No active "SENT" records found. Skipping bounce scan.');
      return;
    }

    // Search for delivery failures in the last 14 days
    const query = '(from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification" OR subject:"Undeliverable" OR subject:"Returned to sender") newer_than:14d';
    vLog(`  - [BOUNCE TRACKER] Querying Gmail threads with filter: ${query}`);
    const threads = GmailApp.search(query, 0, 50);
    vLog(`  - [BOUNCE TRACKER] Found ${threads.length} bounce-related message threads.`);
    let bounceCount = 0;

    threads.forEach((thread, threadIdx) => {
      vLog(`  - [BOUNCE TRACKER] Evaluating Thread #${threadIdx + 1}`);
      const messages = thread.getMessages();
      messages.forEach((msg, msgIdx) => {
        const body = msg.getPlainBody().toLowerCase();
        const subject = msg.getSubject().toLowerCase();
        let rawContent = null; // Lazy loaded to prevent loading large strings from Gmail unless required
        vLog(`    - [BOUNCE TRACKER] Parsing Message #${msgIdx + 1}: Subject: "${msg.getSubject()}"`);

        // Check against our known sent jobs
        for (let j = sentJobs.length - 1; j >= 0; j--) {
          const job = sentJobs[j];
          let updated = false;

          for (let k = 0; k < job.emails.length; k++) {
            if (job.statuses[k] !== 'SENT') continue;
            const email = job.emails[k];
            if (!email) continue;

            // Must contain the target email in the bounce body or raw headers
            let hasEmailMatch = body.includes(email);
            if (!hasEmailMatch) {
              if (rawContent === null) {
                vLog(`      - [BOUNCE TRACKER] [LAZY] Fetching raw message headers for Thread #${threadIdx + 1} Msg #${msgIdx + 1} due to email lookup...`);
                rawContent = msg.getRawContent().toLowerCase();
              }
              hasEmailMatch = rawContent.includes(email);
            }
            if (!hasEmailMatch) continue;

            let isMatch = false;
            // Must also contain the Job ID (or Job Title if ID is missing) to prevent false positives
            if (job.jobId) {
              if (body.includes(job.jobId) || subject.includes(job.jobId)) {
                isMatch = true;
              } else {
                if (rawContent === null) {
                  vLog(`      - [BOUNCE TRACKER] [LAZY] Fetching raw message headers for Thread #${threadIdx + 1} Msg #${msgIdx + 1} due to Job ID lookup...`);
                  rawContent = msg.getRawContent().toLowerCase();
                }
                isMatch = rawContent.includes(job.jobId);
              }
            } else if (job.jobTitle) {
              if (body.includes(job.jobTitle) || subject.includes(job.jobTitle)) {
                isMatch = true;
              } else {
                if (rawContent === null) {
                  vLog(`      - [BOUNCE TRACKER] [LAZY] Fetching raw message headers for Thread #${threadIdx + 1} Msg #${msgIdx + 1} due to Job Title lookup...`);
                  rawContent = msg.getRawContent().toLowerCase();
                }
                isMatch = rawContent.includes(job.jobTitle);
              }
            }

            if (isMatch) {
              vLog(`    - [BOUNCE TRACKER] ⚠️ BOUNCE DETECTED for Job ID: ${job.jobId || job.jobTitle} (${email})`);
              job.statuses[k] = 'BOUNCED';
              persistBouncedAddress(email); // Layer 1: Persist to suppression store immediately
              updated = true;
              bounceCount++;
            }
          }

          if (updated) {
            vLog(`    - [BOUNCE TRACKER] Saving updated row index ${job.rowIndex} with new status configuration: ${job.statuses.join(', ')}`);
            sheet.getRange(job.rowIndex, 2).setValue(job.statuses.join(', '));
            // If no 'SENT' statuses remain for this job, remove it from the tracking array
            if (!job.statuses.includes('SENT')) {
              sentJobs.splice(j, 1);
            }
          }
        }
      });
    });

    vLog(`  - [BOUNCE TRACKER] Scan execution complete. Modified ${bounceCount} bounce statuses.`);
  } catch (e) {
    vLog(`  - [BOUNCE TRACKER] Warning: Tracking execution encountered an error: ${e.message}`);
  }
}

/**
 * Hydrates suppression memory from historical sheet rows already marked BOUNCED.
 * This avoids repeated retries to addresses that failed in prior runs.
 */
function syncBouncedAddressesFromSheet(config) {
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) return;

  try {
    const sheet = SpreadsheetApp.openById(config.spreadsheetLogId).getSheets()[0];
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;

    // Pull Status (B) and Target Email (F)
    const rows = sheet.getRange(2, 2, lastRow - 1, 5).getValues();
    let hydratedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const statusStr = String(rows[i][0] || '').trim().toUpperCase();
      const emailStr = String(rows[i][4] || '').trim();
      if (!statusStr || !emailStr) continue;

      const statuses = statusStr.split(',').map(s => s.trim());
      if (!statuses.includes('BOUNCED')) continue;

      emailStr
        .split(',')
        .map(e => sanitizeEmailAddress(e))
        .filter(Boolean)
        .forEach(email => {
          persistBouncedAddress(email);
          hydratedCount++;
        });
    }

    if (hydratedCount > 0) {
      vLog(`  - [BOUNCE SUPPRESSION] Hydrated ${hydratedCount} bounced target(s) from historical sheet rows.`);
    }
  } catch (e) {
    vLog(`  - [BOUNCE SUPPRESSION] Warning: Could not hydrate historical bounced addresses: ${e.message}`);
  }
}

function persistBouncedAddress(email) {
  if (!email) return;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return;

  if (CACHED_BOUNCED_ADDRESS_SET !== null) {
    CACHED_BOUNCED_ADDRESS_SET.add(normalized);
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const existing = props.getProperty('BOUNCED_ADDRESSES') || '';
    const existingSet = new Set(existing.split('\n').map(e => e.trim()).filter(Boolean));
    if (!existingSet.has(normalized)) {
      existingSet.add(normalized);
      props.setProperty('BOUNCED_ADDRESSES', Array.from(existingSet).join('\n'));
      vLog(`  - [BOUNCE SUPPRESSION] Persisted bounced address to suppression store: ${normalized}`);
    } else {
      vLog(`  - [BOUNCE SUPPRESSION] Address already present in suppression store: ${normalized}`);
    }
  } catch (e) {
    vLog(`  - [BOUNCE SUPPRESSION] Warning: Could not persist bounced address: ${e.message}`);
  }
}

/**
 * Layer 1 (Bounce Suppression) — Returns a Set of all previously-confirmed-bounced
 * email addresses loaded from the Script Properties suppression store.
 */
function getBouncedAddressSet() {
  if (CACHED_BOUNCED_ADDRESS_SET !== null) return CACHED_BOUNCED_ADDRESS_SET;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('BOUNCED_ADDRESSES') || '';
    const addresses = raw.split('\n').map(e => e.trim()).filter(Boolean);
    vLog(`  - [BOUNCE SUPPRESSION] Loaded ${addresses.length} suppressed address(es) from store.`);
    CACHED_BOUNCED_ADDRESS_SET = new Set(addresses);
    return CACHED_BOUNCED_ADDRESS_SET;
  } catch (e) {
    vLog(`  - [BOUNCE SUPPRESSION] Warning: Could not read bounce suppression store: ${e.message}`);
    return new Set();
  }
}

/**
 * Retrieves a set of Job IDs that have already been processed and logged.
 * Optimized to fetch only necessary columns via batch getValues().
 */
function getProcessedJobIds(config) {
  vLog('[PRE-FILTER] Compiling list of previously resolved Job IDs from sheet...');
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('[PRE-FILTER] Logging is currently bypassed. Returning blank exception list.');
    return new Set();
  }

  try {
    const sheet = SpreadsheetApp.openById(config.spreadsheetLogId).getSheets()[0];
    const lastRow = sheet.getLastRow();
    
    if (lastRow <= 1) {
      vLog('[PRE-FILTER] Spreadsheet is empty or contains only headers. Proceeding with clear cache.');
      return new Set();
    }

    // Fetch Status (Col B) and Job ID (Col D)
    const data = sheet.getRange(2, 2, lastRow - 1, 3).getValues();
    const processed = new Set();

    for (let i = 0; i < data.length; i++) {
      const statusStr = String(data[i][0] || '').trim().toUpperCase();
      const jobId = String(data[i][2] || '').trim();
      const statuses = statusStr.split(',').map(s => s.trim());

      // Treat any completed terminal state as processed to prevent duplicate retries.
      if (jobId && (statuses.includes('SENT') || statuses.includes('DRAFTED') || statuses.includes('BOUNCED'))) {
        processed.add(jobId);
      }
    }
    
    vLog(`  - [PRE-FILTER] Detected ${processed.size} historically processed Job IDs.`);
    return processed;
  } catch (e) {
    vLog(`  - [PRE-FILTER] Warning: Failed to populate resolved cache: ${e.message}`);
    return new Set();
  }
}

/**
 * Appends a log entry to the configured Google Sheet using fast batch setValues.
 */
function appendToSpreadsheetLog(params, config) {
  vLog(`[SHEET LOG] Building dispatch logging packet for Job ID: ${params.jobId}...`);
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('[SHEET LOG] Sheet logging bypassed. skipping record entry.');
    return;
  }

  try {
    const sheet = SpreadsheetApp.openById(config.spreadsheetLogId).getSheets()[0];

    if (sheet.getLastRow() === 0) {
      vLog('[SHEET LOG] Targeting blank log sheet. Initializing default column structure...');
      const headers =['Timestamp', 'Status', 'Company', 'Job ID', 'Job Title', 'Target Email', 'Email Tier', 'Score', 'Draft/Message ID', 'Job URL'];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }

    const newRow =[
      getCurrentTimestampString(),
      params.status || 'UNKNOWN',
      params.company || '',
      params.jobId || '',
      params.jobTitle || '',
      params.targetEmail || '',
      params.emailTier || '',
      params.score || '',
      params.messageId || '',
      params.jobUrl || ''
    ];

    vLog(`[SHEET LOG] Appending metadata vector at Row ${sheet.getLastRow() + 1}: ${JSON.stringify(newRow)}`);
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
    vLog(`[SHEET LOG] Successfully verified logging entry.`);
  } catch (e) {
    vLog(`  - [SHEET LOG] Warning: Appending to spreadsheet failed: ${e.message}`);
  }
}

/**
 * Parses the specific markdown format of the material files.
 * Uses a robust first-occurrence regex split and safely amputates trailing tool inputs.
 */
function parseMarkdown(fileContent) {
  vLog('[PARSER] Initiating markdown syntactic decomposition...');
  if (typeof fileContent !== 'string') {
    throw new Error('Cannot parse file content because it is not a string. File may be empty or corrupted.');
  }

  const metadata = {};
  let content = '';

  const separatorRegex = /\r?\n\s*---\s*\r?\n/;
  const match = fileContent.match(separatorRegex);
  
  if (!match) {
    vLog('[PARSER] [FATAL] Target document layout invalid. Missing metadata block divider (---).');
    throw new Error(`Invalid file format. Could not find the "---" separator.`);
  }

  const splitIndex = match.index;
  const metadataBlock = fileContent.substring(0, splitIndex);
  const contentBlock = fileContent.substring(splitIndex + match[0].length);
  
  vLog('[PARSER] Successfully divided file segments into Metadata and Content zones.');
  ['Company', 'Job ID'].forEach(fieldName => {
    const value = extractBoldMetadataField(metadataBlock, fieldName);
    if (!value) throw new Error(`Could not find "${fieldName}" in the Job Metadata section.`);
    metadata[fieldName] = value;
  });
  [
    'Job Title', 'Job URL', 'Application Email', 'Company Address', 'Canonical Company', 
    'Canonical Domain', 'ATS Platform', 'Primary Application URL', 'Recruiter Name', 
    'Recruiter Email', 'Hiring Manager Name', 'Hiring Manager Email'
  ].forEach(fieldName => {
    const value = extractBoldMetadataField(metadataBlock, fieldName);
    if (value) {
      metadata[fieldName] = value;
      vLog(`[PARSER] Parsed Field [${fieldName}]: "${value}"`);
    }
  });

  vLog(`[PARSER] Extracted ${Object.keys(metadata).length} raw metadata keys.`);

  // Split by H1 (#) or H2 (##) to properly segment out inputs/appendices
  const sections = contentBlock.split(/(?=^#{1,2}\s+)/m).map(section => section.trim()).filter(Boolean);
  vLog(`[PARSER] Identified ${sections.length} distinct section containers.`);

  sections.forEach((section, idx) => {
    const headerMatch = section.match(/^#{1,2}\s+(.*)/);
    if (!headerMatch) return;
    
    const title = headerMatch[1].trim();
    const value = section.substring(headerMatch[0].length).trim();
    vLog(`  - [PARSER] Evaluating Header #${idx + 1}: Title: "${title}"`);

    let cleanTitle = title.replace(/^Optimized\s*&\s*Tailored\s+/i, '').trim();
    if (cleanTitle === 'Materials Filename') {
      cleanTitle = 'Resume Filename';
      vLog(`  - [PARSER] Normalizing 'Materials Filename' -> 'Resume Filename'`);
    }

    if (cleanTitle === 'Cover Letter') {
      // Bulletproof slice: If the generator forgot a newline and jammed ## INPUTS 
      // against the last sentence, this cleanly amputates it.
      content = value.split(/#{1,3}\s*INPUTS/i)[0].trim();
      vLog('  - [PARSER] Segmented and extracted Cover Letter block.');
    } else if (cleanTitle && !/INPUTS/i.test(cleanTitle)) {
      metadata[cleanTitle] = value;
      vLog(`  - [PARSER] Metadata Section Field [${cleanTitle}] mapped => value length: ${value.length} chars.`);
    }
  });

  if (!content) {
    vLog('[PARSER] [FATAL] Critical structural error: Cover Letter text block was not resolved.');
    throw new Error('Could not find a non-empty "# Cover Letter" section in the source material file.');
  }

  return { metadata, content };
}

/**
 * Extracts a markdown bold metadata field flexibly matching variations like **Field:** or **Field**:
 */
function extractBoldMetadataField(metadataBlock, fieldName) {
  const escapedFieldName = escapeRegex(fieldName);
  const pattern = new RegExp(`^\\s*\\*\\*${escapedFieldName}[\\*:\\s]*(.+?)\\s*$`, 'im');
  const match = String(metadataBlock || '').match(pattern);
  return match && match[1] ? match[1].trim() : '';
}

/**
 * Format corporate address block matching standard layouts
 */
function formatCorporateHQAddressBlock(metadata, rawAddress, companyName) {
  vLog(`[ADDRESS FORMATTING] Starting HQ address block compilation...`);
  vLog(`[ADDRESS FORMATTING] Input rawAddress: "${rawAddress}"`);
  vLog(`[ADDRESS FORMATTING] Input companyName: "${companyName}"`);

  const managerName = getMetadataValue(metadata, 'Hiring Manager Name');
  const recruiterName = getMetadataValue(metadata, 'Recruiter Name');
  
  // 1. [Hiring Manager Name / Department, if known]
  let contactLine = '';
  if (managerName) {
    contactLine = managerName;
    vLog(`[ADDRESS FORMATTING] Contact entity identified (Hiring Manager Name): "${contactLine}"`);
  } else if (recruiterName) {
    contactLine = recruiterName;
    vLog(`[ADDRESS FORMATTING] Contact entity identified (Recruiter Name): "${contactLine}"`);
  } else {
    vLog(`[ADDRESS FORMATTING] No direct Hiring Manager or Recruiter name found in metadata. Omitting top contact line.`);
  }

  const lines = [];
  
  if (contactLine) {
    lines.push(contactLine);
  }
  
  // 2. [Company Name]
  if (companyName) {
    lines.push(companyName);
  }
  
  // 3. [Street Address] & 4. [City, State ZIP Code]
  if (rawAddress) {
    const addressLines = rawAddress.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    vLog(`[ADDRESS FORMATTING] Split rawAddress into ${addressLines.length} component line(s).`);

    // Filter out duplicate lines (e.g. if rawAddress already starts with company name or contact name)
    const cleanedAddressLines = addressLines.filter(line => {
      const lowerLine = line.toLowerCase();
      const lowerCompany = companyName ? companyName.toLowerCase() : '';
      const lowerContact = contactLine ? contactLine.toLowerCase() : '';
      
      if (lowerCompany && (lowerLine === lowerCompany || lowerLine.startsWith(lowerCompany + ','))) {
        vLog(`[ADDRESS FORMATTING] Filtering out redundant company name line: "${line}"`);
        return false;
      }
      if (lowerContact && lowerLine === lowerContact) {
        vLog(`[ADDRESS FORMATTING] Filtering out redundant contact name line: "${line}"`);
        return false;
      }
      return true;
    });

    lines.push(...cleanedAddressLines);
  }

  const finalizedBlock = lines.join('\n');
  vLog(`[ADDRESS FORMATTING] Compiled block:\n${finalizedBlock}`);
  return finalizedBlock;
}

/**
 * Fallback to fetch only the corporate HQ address if LLM discovery was skipped (manual email used).
 */
function fetchCompanyAddress(companyName, metadata, config) {
  vLog(`[ADDRESS SCRAPER] Accessing corporate mailing records for: ${companyName}...`);
  const jobUrl = getMetadataValue(metadata, 'Job URL');
  const canonicalDomain = getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(jobUrl);

  const prompt = `
Return the best current corporate mailing address for the company below.

Company: ${companyName || 'UNKNOWN'}
Canonical domain, if known: ${canonicalDomain || 'UNKNOWN'}
Job URL, if known: ${jobUrl || 'UNKNOWN'}

Rules:
- Prefer the company entity connected to the provided job URL/domain.
- Avoid similarly named but unrelated companies.
- Format as an envelope address containing street number, city, state, zip code (preferably in ALL CAPS).
- Include company name.
- Return only the address lines. No commentary.
`.trim();

  vLog(`[ADDRESS SCRAPER] Prompt payload built. length: ${prompt.length} characters.`);
  try {
    const fullResponse = askOpenRouter(prompt, config, { temperature: 0.15, top_p: 0.8 });
    const cleaned = cleanOpenRouterPlainTextResponse(fullResponse);
    vLog(`[ADDRESS SCRAPER] Resolved Mailing Address response:\n${cleaned}`);
    return cleaned;
  } catch (e) {
    vLog(`[ADDRESS SCRAPER] [WARNING] Corporate address lookup failed: ${e.message}`);
    return getMetadataValue(metadata, 'Company Address') || '';
  }
}

/**
 * Cleans common non-answer artifacts and reasoning tags from OpenRouter plaintext responses.
 */
function cleanOpenRouterPlainTextResponse(fullResponse) {
  let cleaned = String(fullResponse || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const lines = cleaned.split('\n');
  const filteredLines =[];

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    if (trimmedLine === '---') break;
    if (trimmedLine.startsWith('>') || trimmedLine.startsWith('[')) continue;
    if (trimmedLine.includes('*Thinking...*')) continue; 
    filteredLines.push(lines[i]);
  }

  return filteredLines.join('\n').trim();
}

/**
 * Calls OpenRouter and returns choices[0].message.content with exponential backoff.
 */
function askOpenRouter(prompt, config, overrides) {
  overrides = overrides || {};
  const maxAttempts = typeof overrides.maxAttempts === 'number' ? Math.max(1, overrides.maxAttempts) : 3;
  const retryBaseMs = typeof overrides.retryBaseMs === 'number' ? Math.max(0, overrides.retryBaseMs) : 1000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      vLog(`[LLM GATEWAY] Invoking OpenRouter transaction [Attempt ${attempt}/${maxAttempts}]...`);
      return askOpenRouterOnce(prompt, config, overrides);
    } catch (e) {
      lastError = e;
      const shouldRetry = isRetryableOpenRouterError(e) && attempt < maxAttempts;
      if (!shouldRetry) {
        vLog(`[LLM GATEWAY] [FATAL] Transaction failed irrecoverably: ${e.message}`);
        throw e;
      }

      const sleepMs = retryBaseMs * Math.pow(2, attempt - 1);
      vLog(`[LLM GATEWAY] Attempt ${attempt} hit retryable latency error: ${e.message}. backing off for ${sleepMs} ms.`);
      Utilities.sleep(sleepMs);
    }
  }

  throw lastError || new Error('OpenRouter API request failed for an unknown reason.');
}

/**
 * Calls OpenRouter once.
 */
function askOpenRouterOnce(prompt, config, overrides) {
  const payload = {
    model: OPENROUTER_MODEL,
    messages:[{ role: 'user', content: prompt }],
    stream: false,
    temperature: typeof overrides.temperature === 'number' ? overrides.temperature : 0.25,
    top_p: typeof overrides.top_p === 'number' ? overrides.top_p : 0.9
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 
      'Authorization': `Bearer ${config.orApiKey}`,
      'HTTP-Referer': 'https://google.com', 
      'X-Title': 'Apps Script Job Material Pipeline'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  vLog(`[API EXECUTION] Target endpoint: ${OPENROUTER_API_URL}`);
  vLog(`[API EXECUTION] Active model mapping: ${OPENROUTER_MODEL}`);
  vLog(`[API EXECUTION] Payload parameters size: ${JSON.stringify(payload).length} chars.`);

  const response = UrlFetchApp.fetch(OPENROUTER_API_URL, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  vLog(`[API EXECUTION] Returned raw response Code: ${responseCode}`);
  vLog(`[API EXECUTION] Raw response payload length: ${responseBody.length} characters.`);

  if (responseCode !== 200) {
    vLog(`[API ERROR] Non-200 Status output: ${responseBody}`);
    const error = new Error(`OpenRouter API request failed with status code ${responseCode}. Response: ${responseBody}`);
    error.responseCode = responseCode;
    throw error;
  }

  let jsonResponse;
  try {
    jsonResponse = JSON.parse(responseBody);
  } catch (parseError) {
    vLog(`[API ERROR] Execution returned malformed JSON payload.`);
    throw new Error(`OpenRouter API returned non-JSON response.`);
  }

  const content = jsonResponse?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    if (jsonResponse?.error?.message) {
      vLog(`[API ERROR] OpenRouter returned API error: ${jsonResponse.error.message}`);
      throw new Error(`OpenRouter API returned error: ${jsonResponse.error.message}`);
    }
    vLog(`[API ERROR] Complied structure is missing text targets choices[0].message.content.`);
    throw new Error(`OpenRouter API response did not contain message content.`);
  }

  vLog(`[API SUCCESS] Extracted choice content (${content.length} characters). Preview:\n${content.substring(0, 300)}...`);
  return content.trim();
}

/**
 * Returns true for transient OpenRouter/API failures worth retrying.
 */
function isRetryableOpenRouterError(error) {
  if (!error) return false;
  
  // If we have an HTTP status code, retry on 408, 409, 425, 429, and 5xx
  if (error.responseCode) {
    const code = Number(error.responseCode);
    return code === 408 || code === 409 || code === 425 || code === 429 || (code >= 500 && code <= 599);
  }
  
  // If there's no response code, it is a network-level or timeout exception from Google's infrastructure
  const msg = String(error.message || '').toLowerCase();
  vLog(`[LLM GATEWAY] Network-level exception encountered: "${msg}". Treating as retryable transient failure.`);
  return true;
}

/**
 * Discovers ranked application and hail-mary email routes, AND extracts company address.
 */
function discoverApplicationEmailRoutes(metadata, config) {
  vLog('[DISCOVERY] Initiating strategic intake and contact routing heuristics...');
  const manualCandidate = getManualEmailCandidate(metadata);

  if (manualCandidate && manualCandidate.recommendedAction !== DISCOVERY_ACTIONS.SUPPRESS) {
    vLog(`[DISCOVERY] Manually declared routing override resolved: "${manualCandidate.email}". Skipping API intelligence lookup.`);
    return normalizeApplicationEmailDiscoveryResult({
      canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
      canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
      entity_confidence: 1,
      primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
      ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
      all_candidates: [manualCandidate],
      suppressed_candidates:[],
      notes: 'Manual source-file email detected. AI Discovery skipped.'
    }, metadata, 'manual');
  }

  vLog('[DISCOVERY] No valid manual email detected. Querying LLM matrix mapping via OpenRouter...');
  let parsed = null;
  let fullResponse = '';

  try {
    const prompt = buildApplicationEmailDiscoveryPrompt(metadata, config);
    fullResponse = askOpenRouter(prompt, config, { temperature: 0.12, top_p: 0.75 });
    vLog('[DISCOVERY] Extracting JSON structure from raw text response...');
    parsed = parseJsonObjectFromText(fullResponse);
  } catch (e) {
    vLog(`[DISCOVERY] [WARNING] Email discovery API call or parsing failed: ${e.message}`);
    if (manualCandidate) {
      vLog(`[DISCOVERY] Falling back to manual email candidate: "${manualCandidate.email}"`);
      return normalizeApplicationEmailDiscoveryResult({
        canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
        canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
        entity_confidence: 1,
        primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
        ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
        all_candidates: [manualCandidate],
        suppressed_candidates: [],
        notes: `OpenRouter lookup failed (${e.message}). Used manual candidate fallback.`
      }, metadata, 'manual');
    }

    return normalizeApplicationEmailDiscoveryResult({
      canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
      canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
      entity_confidence: 0,
      primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
      ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
      all_candidates: [],
      suppressed_candidates: [],
      notes: `Email discovery API/parsing failed: ${e.message}`
    }, metadata, 'openrouter');
  }

  vLog('[DISCOVERY] Executing normalization engine...');
  const normalized = normalizeApplicationEmailDiscoveryResult(parsed, metadata, 'openrouter');
  normalized.rawResponse = fullResponse;

  if (manualCandidate) {
    vLog(`[DISCOVERY] Merging suppressed candidate record to suppression list: ${manualCandidate.email}`);
    normalized.suppressedCandidates.push(manualCandidate);
  }

  vLog(`[DISCOVERY] Strategic tracking finished. Best resolved email endpoint: ${normalized.bestEmail || 'NONE'} (Priority Score: ${normalized.score})`);
  return normalized;
}

/**
 * Builds the Strategic Contact Discovery prompt.
 */
function buildApplicationEmailDiscoveryPrompt(metadata, config) {
  const companyName = getMetadataValue(metadata, 'Company');
  const jobId = getMetadataValue(metadata, 'Job ID');
  const jobUrl = getMetadataValue(metadata, 'Job URL');
  const jobTitle = getBestJobTitle(metadata);
  const companyAddress = getMetadataValue(metadata, 'Company Address');
  const canonicalCompany = getMetadataValue(metadata, 'Canonical Company');
  const canonicalDomain = getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(jobUrl);
  const atsPlatform = getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(jobUrl);

  vLog(`[PROMPT BUILDER] Fetching parameters: Company="${companyName}", Title="${jobTitle}", JobID="${jobId}"`);

  return `
You are performing Strategic Contact Discovery for a job application hail-mary workflow.

Goal:
Find the most suitable publicly documented professional email address that could plausibly route a resume and cover letter to recruiting, talent acquisition, HR, the hiring team, or a general company intake.

Inputs:
- Company / organization: ${companyName || 'UNKNOWN'}
- Canonical company, if known: ${canonicalCompany || 'UNKNOWN'}
- Canonical domain, if known: ${canonicalDomain || 'UNKNOWN'}
- Job title: ${jobTitle || 'UNKNOWN'}
- Job ID: ${jobId || 'UNKNOWN'}
- Job URL: ${jobUrl || 'UNKNOWN'}
- Detected ATS platform, if known: ${atsPlatform || 'UNKNOWN'}
- Company address, if known: ${companyAddress || 'UNKNOWN'}
- Applicant name: ${config.applicantName}

Critical entity-resolution rules:
1. Verify the correct company entity and canonical domain before recommending any address.
2. Reject similarly named but unrelated companies.
3. If you detect an ATS platform, return the most direct ATS job/application URL as primary_application_url.
4. Prefer documented email addresses with direct evidence. If no explicit inbox can be verified, include at most one conservative fallback route tied to the canonical domain, clearly caveated with lower confidence.

Evidence requirements:
- Populate evidence_urls with real, verifiable URLs where you actually found the address (e.g. the company's own careers page, an official job posting, a press release). Do not fabricate or guess URLs.
- If you have no documentary evidence for an address, set source_type to "unknown" or "heuristic_pattern", confidence to 0.60 or lower, and include a clear caveat.
- A plausible-looking address with zero evidence is NOT the same as a known address. Mark it backup_only or suppress it — do not set it as best_email.

Email tiering:
A. OFFICIAL_APPLICATION_INTAKE: Explicitly accepts applications/resumes.
B. OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT: Recruiting, careers, talent, candidate help, or TA-adjacent.
C. OFFICIAL_GENERAL_CONTACT: contact@, info@, hello@, or equivalent official company intake.
D. PUBLIC_RECRUITER_OR_HIRING_TEAM: Publicly listed professional email for relevant recruiter.
E. OTHER_PUBLIC_ROUTE: Public but weaker route.
F. SUPPRESSED: Do not use.

Suppression rules:
- Do NOT recommend no-reply, privacy, security, abuse, legal, press, media, investor-relations, postmaster, webmaster, billing, sales, or unrelated departmental inboxes.
- Do NOT recommend disability-accommodation or accessibility-specific inboxes.
- Do NOT return multiple speculative guessed inboxes; keep speculative fallbacks to one maximum and clearly caveated.

Return ONLY valid JSON. No markdown. No commentary outside JSON.

JSON schema:
{
  "company_mailing_address": "string (HQ mailing address containing street, city, state, zip in envelope format, or null)",
  "canonical_company": "string",
  "canonical_domain": "string",
  "entity_confidence": 0.0,
  "entity_notes": "brief explanation, especially any collision risk",
  "primary_application_url": "Prefer the direct ATS job/application URL over LinkedIn when discoverable.",
  "ats_platform": "string or null",
  "best_email": {
    "email": "string or null",
    "tier": "OFFICIAL_APPLICATION_INTAKE | OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT | OFFICIAL_GENERAL_CONTACT | PUBLIC_RECRUITER_OR_HIRING_TEAM | OTHER_PUBLIC_ROUTE | SUPPRESSED",
    "confidence": 0.0,
    "score": 0,
    "source_type": "official_company_page | official_careers_page | official_job_posting | ats_page | public_professional_page | third_party | heuristic_pattern | manual | unknown",
    "evidence_urls":["string"],
    "evidence_summary": "brief evidence summary",
    "caveat": "brief caveat",
    "recommended_action": "create_draft | backup_only | suppress"
  },
  "all_candidates":[
    {
      "email": "string",
      "tier": "OFFICIAL_APPLICATION_INTAKE | OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT | OFFICIAL_GENERAL_CONTACT | PUBLIC_RECRUITER_OR_HIRING_TEAM | OTHER_PUBLIC_ROUTE | SUPPRESSED",
      "confidence": 0.0,
      "score": 0,
      "source_type": "official_company_page | official_careers_page | official_job_posting | ats_page | public_professional_page | third_party | heuristic_pattern | manual | unknown",
      "evidence_urls":["string"],
      "evidence_summary": "brief evidence summary",
      "caveat": "brief caveat",
      "recommended_action": "create_draft | backup_only | suppress"
    }
  ],
  "suppressed_candidates":[
    {
      "email": "string",
      "reason": "brief reason"
    }
  ],
  "notes": "brief notes"
}
`.trim();
}

/**
 * Returns a manual metadata email candidate, if supplied.
 */
function getManualEmailCandidate(metadata) {
  const manualSource = getManualEmailSource(metadata);
  const manualEmail = sanitizeEmailAddress(manualSource.email);

  if (!manualEmail) return null;
  vLog(`[DISCOVERY] Manual configuration parsed from source variables: ${manualEmail}`);

  const baseCandidate = {
    email: manualEmail,
    tier: manualSource.tier,
    confidence: manualSource.confidence,
    score: manualSource.score,
    sourceType: 'manual',
    evidenceUrls:[],
    evidenceSummary: manualSource.evidenceSummary,
    caveat: manualSource.caveat,
    recommendedAction: manualSource.recommendedAction
  };

  if (!isValidEmailAddress(manualEmail)) {
    vLog(`[DISCOVERY] [WARNING] Declared manual routing address fails syntax check. Suppressing.`);
    baseCandidate.tier = DISCOVERY_TIERS.SUPPRESSED;
    baseCandidate.recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    return baseCandidate;
  }

  const suppressionReason = getSuppressionReasonForEmail(manualEmail, {
    evidenceSummary: manualSource.evidenceSummary,
    caveat: manualSource.caveat,
    tier: manualSource.tier,
    sourceType: 'manual'
  });

  if (suppressionReason) {
    vLog(`[DISCOVERY] [WARNING] Declared manual routing matches rule suppression criteria: ${suppressionReason}`);
    baseCandidate.tier = DISCOVERY_TIERS.SUPPRESSED;
    baseCandidate.recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    baseCandidate.suppressionReason = suppressionReason;
  }

  return baseCandidate;
}

/**
 * Returns the highest-priority manual email source from metadata.
 */
function getManualEmailSource(metadata) {
  const sources =[
    {
      field: 'Application Email',
      email: getMetadataValue(metadata, 'Application Email'),
      tier: DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE,
      confidence: 1,
      score: 100,
      evidenceSummary: 'Application Email was supplied directly in the material file.',
      caveat: 'Manual source-file value used.',
      recommendedAction: DISCOVERY_ACTIONS.CREATE_DRAFT
    },
    {
      field: 'Recruiter Email',
      email: getMetadataValue(metadata, 'Recruiter Email'),
      tier: DISCOVERY_TIERS.PUBLIC_RECRUITER_OR_HIRING_TEAM,
      confidence: 0.86,
      score: 82,
      evidenceSummary: 'Recruiter Email was supplied directly in the material file.',
      caveat: 'Manual recruiter route.',
      recommendedAction: DISCOVERY_ACTIONS.CREATE_DRAFT
    }
  ];

  for (let i = 0; i < sources.length; i++) {
    if (sanitizeEmailAddress(sources[i].email)) return sources[i];
  }

  return { email: '', tier: DISCOVERY_TIERS.SUPPRESSED, recommendedAction: DISCOVERY_ACTIONS.SUPPRESS };
}

/**
 * Parses a JSON object from an LLM response safely, resilient to reasoning tags.
 */
function parseJsonObjectFromText(text) {
  let cleaned = String(text).trim();
  // Strip <think> tags if present before parsing JSON
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  
  try {
    return JSON.parse(cleaned);
  } catch (directError) {
    vLog(`[PARSER] Direct JSON parse failed. Extracting matching text block boundaries...`);
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      } catch (e) {
        vLog(`[PARSER] Substring block extraction parsed invalid structural JSON: ${e.message}`);
        throw new Error(`Extracted JSON was invalid: ${e.message}`);
      }
    }
    throw new Error(`Could not locate a valid JSON object in OpenRouter response.`);
  }
}

/**
 * Normalizes the ranked discovery result and applies deterministic scoring/suppression.
 */
function normalizeApplicationEmailDiscoveryResult(result, metadata, source) {
  result = result || {};

  const canonicalDomain = normalizeDomain(result.canonical_domain || result.canonicalDomain || getMetadataValue(metadata, 'Canonical Domain'));
  const canonicalCompany = oneLinePlainText(result.canonical_company || result.canonicalCompany || getMetadataValue(metadata, 'Company'));
  const companyMailingAddress = cleanLlmText(result.company_mailing_address || result.companyMailingAddress || '');

  vLog(`[NORMALIZER] Derived Domain: "${canonicalDomain}", Resolved Name: "${canonicalCompany}"`);

  const defaultEntityConfidence = source === 'manual' ? 1 : 0.4;
  const entityConfidence = parseConfidenceScore(result.entity_confidence ?? result.entityConfidence ?? defaultEntityConfidence);
  vLog(`[NORMALIZER] Verified Entity Confidence Rating: ${entityConfidence}`);

  const primaryApplicationUrl = sanitizeUrl(result.primary_application_url || result.primaryApplicationUrl || getMetadataValue(metadata, 'Job URL'));
  const atsPlatform = oneLinePlainText(result.ats_platform || result.atsPlatform || getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(primaryApplicationUrl));

  const candidateInputs =[];
  if (result.best_email || result.bestEmail) candidateInputs.push(result.best_email || result.bestEmail);
  asArray(result.all_candidates || result.allCandidates).forEach(c => candidateInputs.push(c));

  const candidates =[];
  const seenEmails = {};

  candidateInputs.forEach(candidateInput => {
    const normalizedCandidate = normalizeDiscoveryCandidate(candidateInput, { metadata, canonicalCompany, canonicalDomain, entityConfidence, primaryApplicationUrl, atsPlatform });
    if (!normalizedCandidate.email) return;

    if (seenEmails[normalizedCandidate.email]) {
      mergeCandidateEvidence(seenEmails[normalizedCandidate.email], normalizedCandidate);
    } else {
      seenEmails[normalizedCandidate.email] = normalizedCandidate;
      candidates.push(normalizedCandidate);
    }
  });

  const suppressedCandidates = asArray(result.suppressed_candidates || result.suppressedCandidates)
    .map(normalizeSuppressedCandidate).filter(c => c.email || c.reason);

  const sortedCandidates = candidates.sort((a, b) => b.score - a.score);
  
  // Tag ALL candidates that meet the threshold for drafting
  finalizeCandidateActions(sortedCandidates, entityConfidence);

  const logCandidates = sortedCandidates.slice(0, MAX_DISCOVERY_CANDIDATES_TO_LOG);
  if (logCandidates.length > 0) {
    logCandidates.forEach((candidate, idx) => {
      vLog(`  - [DISCOVERY] Ranked Candidate #${idx + 1}: ${candidate.email} | tier=${candidate.tier} | score=${candidate.score} | action=${candidate.recommendedAction}`);
    });
  } else {
    vLog('  - [DISCOVERY] No valid candidates survived normalization.');
  }
  
  const draftableCandidates = sortedCandidates.filter(c => c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT);
  const bestCandidate = draftableCandidates.length > 0 ? draftableCandidates[0] : null;
  const score = bestCandidate ? bestCandidate.score : 0;

  const normalized = {
    companyMailingAddress,
    canonicalCompany,
    canonicalDomain,
    entityConfidence,
    entityNotes: cleanLlmText(result.entity_notes || result.entityNotes || ''),
    primaryApplicationUrl,
    atsPlatform,
    candidates: sortedCandidates,
    allCandidates: sortedCandidates,
    suppressedCandidates,
    bestCandidate,
    bestEmail: bestCandidate ? bestCandidate.email : '',
    score,
    confidenceLabel: scoreToLabel(score),
    shouldCreateDraft: draftableCandidates.length > 0,
    notes: cleanLlmText(result.notes || '')
  };

  if (!normalized.notes && !bestCandidate) normalized.notes = 'No draftable public professional email candidate was found.';
  if (entityConfidence < APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE) {
    vLog(`[NORMALIZER] [WARNING] Trust validation fallback: Entity confidence (${entityConfidence}) below limit threshold. Bypassing automatic generation.`);
    normalized.shouldCreateDraft = false;
    normalized.notes = appendSentence(normalized.notes, `Entity confidence is below threshold (${entityConfidence}). Draft creation suppressed.`);
  }

  return normalized;
}

/**
 * Normalizes one candidate.
 */
function normalizeDiscoveryCandidate(candidateInput, context) {
  const raw = typeof candidateInput === 'string' ? { email: candidateInput } : (candidateInput || {});
  const email = sanitizeEmailAddress(raw.email || raw.address || '');
  const localPart = getEmailLocalPart(email);
  const evidenceUrls = asArray(raw.evidence_urls || raw.evidenceUrls).map(sanitizeUrl).filter(Boolean);

  const evidenceSummary = cleanLlmText(raw.evidence_summary || raw.evidenceSummary || raw.reason || '');
  const caveat = cleanLlmText(raw.caveat || raw.notes || '');
  const sourceType = normalizeSourceType(raw.source_type || raw.sourceType || raw.source || 'unknown');
  const reportedTier = normalizeDiscoveryTier(raw.tier || raw.category || '');
  const reportedScore = parseScoreTo100(raw.score || raw.confidence_score || raw.confidence || 0);

  let tier = reportedTier || classifyCandidateTier(email, { evidenceSummary, caveat, sourceType });
  let recommendedAction = DISCOVERY_ACTIONS.BACKUP_ONLY;
  let suppressionReason = '';

  if (!email || !isValidEmailAddress(email)) {
    tier = DISCOVERY_TIERS.SUPPRESSED;
    recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
  } else {
    suppressionReason = getSuppressionReasonForEmail(email, { evidenceSummary, caveat, sourceType, tier });
    if (suppressionReason) {
      tier = DISCOVERY_TIERS.SUPPRESSED;
      recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    } else if (tier === DISCOVERY_TIERS.SUPPRESSED && isRecruitingOrCareerLocalPart(localPart)) {
      tier = DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT;
    } else if (tier === DISCOVERY_TIERS.SUPPRESSED) {
      recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    }
  }

  const score = recommendedAction === DISCOVERY_ACTIONS.SUPPRESS ? 0 : computeCandidateScore({ email, tier, sourceType, evidenceUrls, evidenceSummary, caveat, reportedScore, context });
  if (recommendedAction !== DISCOVERY_ACTIONS.SUPPRESS) recommendedAction = actionForScore(score);

  vLog(`  - [DISCOVERY MODULE] Candidate Evaluator: "${email}": Category Tier=${tier}, Priority Rating=${score}, Routing Decision=${recommendedAction}`);
  return { email, tier, score, sourceType, evidenceUrls, evidenceSummary, caveat, recommendedAction, suppressionReason };
}

/**
 * Computes a deterministic score.
 */
function computeCandidateScore(candidate) {
  if (!candidate.email || !isValidEmailAddress(candidate.email)) return 0;

  // FIX (Bug 2): Use the LLM's reportedScore as a gentle directional hint only,
  // not as a fixed anchor. Dampening to 30% weight prevents a model that always
  // returns the same value (e.g. 0.92) from freezing every score at that number
  // before the deterministic bonuses/penalties are even applied.
  let score = candidate.reportedScore > 0
    ? 35 + Math.round((candidate.reportedScore - 35) * 0.3)
    : 35;

  const localPart = getEmailLocalPart(candidate.email);
  const emailDomain = normalizeDomain(candidate.email.split('@')[1]);
  const canonicalDomain = normalizeDomain(candidate.context.canonicalDomain);
  const evidenceText = `${candidate.evidenceSummary} ${candidate.caveat} ${candidate.sourceType}`.toLowerCase();

  if (canonicalDomain && domainMatchesOrSubdomain(emailDomain, canonicalDomain)) score += 18;
  else if (canonicalDomain && emailDomain && !domainLooksLikePublicEmailProvider(emailDomain)) score -= 10;

  if (candidate.sourceType === 'official_careers_page' || candidate.sourceType === 'official_job_posting') score += 18;
  else if (candidate.sourceType === 'official_company_page') score += 14;
  else if (candidate.sourceType === 'ats_page') score += 10;
  else if (candidate.sourceType === 'heuristic_pattern') score -= 12;
  else if (candidate.sourceType === 'third_party') score -= 28;

  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE) score += 25;
  else if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT) score += 18;
  else if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_GENERAL_CONTACT) score += 8;

  if (isRecruitingOrCareerLocalPart(localPart)) score += 15;
  if (/\b(not for applications|do not send)\b/i.test(evidenceText)) score -= 35;
  if (candidate.context.entityConfidence < APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE) score -= 40;

  // Penalize candidates backed by zero documentary evidence.
  if (!candidate.evidenceUrls || candidate.evidenceUrls.length === 0) score -= 12;

  return applyCandidateScoreCaps(Math.round(score), candidate);
}

function applyCandidateScoreCaps(score, candidate) {
  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE) return Math.max(0, Math.min(100, score));
  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT) return Math.max(0, Math.min(95, score));
  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_GENERAL_CONTACT) return Math.max(0, Math.min(90, score));
  return Math.max(0, Math.min(84, score));
}

function mergeCandidateEvidence(target, incoming) {
  target.score = Math.max(target.score, incoming.score);
  if (incoming.tier && tierRank(incoming.tier) > tierRank(target.tier)) target.tier = incoming.tier;
  target.evidenceUrls = Array.from(new Set([].concat(target.evidenceUrls || [], incoming.evidenceUrls || [])));
  if (incoming.evidenceSummary && !target.evidenceSummary.includes(incoming.evidenceSummary)) target.evidenceSummary = appendSentence(target.evidenceSummary, incoming.evidenceSummary);
  target.recommendedAction = actionForScore(target.score);
}

function finalizeCandidateActions(candidates, entityConfidence) {
  candidates.forEach(candidate => {
    if (candidate.recommendedAction === DISCOVERY_ACTIONS.SUPPRESS) return;
    candidate.recommendedAction = shouldCreateDraftForCandidate(candidate, entityConfidence)
      ? DISCOVERY_ACTIONS.CREATE_DRAFT
      : DISCOVERY_ACTIONS.BACKUP_ONLY;
  });
}

function shouldCreateDraftForCandidate(candidate, entityConfidence) {
  if (!ENABLE_EMAIL_DISPATCH || APPLICATION_DRAFT_MODE === 'OFF' || !candidate || entityConfidence < APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE) return false;
  if (candidate.recommendedAction === DISCOVERY_ACTIONS.SUPPRESS) return false;
  if (APPLICATION_DRAFT_MODE === 'VERIFIED_ONLY') return candidate.score >= APPLICATION_EMAIL_HIGH_SCORE;
  if (APPLICATION_DRAFT_MODE === 'MEDIUM_PLUS') return candidate.score >= APPLICATION_EMAIL_MEDIUM_SCORE;
  return candidate.score >= APPLICATION_EMAIL_HAIL_MARY_SCORE;
}

function actionForScore(score) {
  if (score >= APPLICATION_EMAIL_HAIL_MARY_SCORE) return DISCOVERY_ACTIONS.CREATE_DRAFT;
  if (score > 0) return DISCOVERY_ACTIONS.BACKUP_ONLY;
  return DISCOVERY_ACTIONS.SUPPRESS;
}

// Simple mapping conversion
function scoreToLabel(score) {
  if (score >= APPLICATION_EMAIL_HIGH_SCORE) return 'HIGH';
  if (score >= APPLICATION_EMAIL_MEDIUM_SCORE) return 'MEDIUM';
  if (score >= APPLICATION_EMAIL_HAIL_MARY_SCORE) return 'LOW';
  return 'NONE';
}

function normalizeSuppressedCandidate(candidate) {
  if (typeof candidate === 'string') return { email: sanitizeEmailAddress(candidate), reason: '' };
  return { email: sanitizeEmailAddress(candidate.email || ''), reason: cleanLlmText(candidate.reason || '') };
}

function associateApplicationEmailDiscovery(metadata, result) {
  const bestCandidate = result.bestCandidate || null;
  metadata['Application Email Discovery Status'] = result.shouldCreateDraft ? 'DRAFTABLE_EMAIL_FOUND' : 'NO_DRAFTABLE_EMAIL_FOUND';
  metadata['Application Email'] = bestCandidate ? bestCandidate.email : '';
  metadata['Application Email Score'] = String(result.score || 0);
  metadata['Application Email Tier'] = bestCandidate ? bestCandidate.tier : '';
}

function annotateGeneratedFilesWithApplicationEmail(files, metadata, discoveryResult) {
  if (!ANNOTATE_DRIVE_FILES_WITH_DISCOVERY || !files || !files.length) return;
  vLog(`[FILE META] Appending tracking notes and evidence to generated files...`);
  
  const candidates = asArray(discoveryResult && discoveryResult.candidates);
  const draftableEmails = candidates
    .filter(c => c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .slice(0, MAX_DISCOVERY_CANDIDATES_TO_ANNOTATE)
    .map(c => `${c.email} (${c.score}/100)`)
    .join(', ');

  const emailLine = draftableEmails ? `Target Emails: ${draftableEmails}` : 'Target Emails: NONE';

  const lines =[
    'Application email discovery:',
    `Status: ${getMetadataValue(metadata, 'Application Email Discovery Status') || 'UNKNOWN'}`,
    `Canonical Domain: ${discoveryResult.canonicalDomain || 'UNKNOWN'}`,
    emailLine
  ].join('\n');
  
  files.forEach(file => {
    vLog(`  - [FILE META] Appending annotation parameters to file: "${file.getName()}" (ID: ${file.getId()})`);
    appendDriveFileDescription(file, lines);
  });
}

function appendDriveFileDescription(file, note) {
  try {
    const existing = String(file.getDescription() || '').trim();
    let combined = `${existing}${existing ? '\n\n---\n' : ''}${note}`;
    if (combined.length > 4900) {
      // Truncate the OLD text from the top so the new note is always visible at the bottom
      const excess = combined.length - 4900;
      combined = '...' + combined.substring(excess + 3);
    }
    file.setDescription(combined);
  } catch (e) {
    vLog(`Warning: Failed to append file description to ${file.getId()}: ${e.message}`);
  }
}

function getFullDocumentText(doc) {
  let text = '';
  [doc.getHeader(), doc.getBody(), doc.getFooter()].forEach(container => {
    if (container) text += container.getText().replace(/\r\n/g, '\n').replace(/[\r\v]/g, '\n').trim() + '\n\n\n';
  });
  return text.replace(/([^\n])\n+(Dear\s|To\s|Greetings|Hi\s)/gi, '$1\n\n$2').trim();
}

/**
 * Dispatches the Application Email Draft or Automated Send
 */
function dispatchApplicationEmail(metadata, fullCoverLetterText, resumeFile, discoveryResult, config) {
  vLog('[EMAIL ENGINE] preparing and constructing envelope dispatch packets...');
  if (!ENABLE_EMAIL_DISPATCH) throw new Error('Email dispatch is disabled.');
  
  // Extract ALL draftable email candidates
  let targetEmails = discoveryResult.candidates
    .filter(c => c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .map(c => sanitizeEmailAddress(c.email))
    .filter(Boolean);

  // Fallback to manual metadata if no candidates passed the threshold
  if (targetEmails.length === 0) {
    const fallback = sanitizeEmailAddress(getMetadataValue(metadata, 'Application Email'));
    vLog(`[EMAIL ENGINE] AI validation resolved 0 targets. Attempting fallback on manually declared targets: "${fallback}"`);
    if (fallback) targetEmails.push(fallback);
  }

  // Deduplicate emails cleanly
  targetEmails = [...new Set(targetEmails)];

  const initialEmailsCount = targetEmails.length;
  const initialEmails = [...targetEmails];

  // Layer 1 (Bounce Suppression): Remove any address that has previously bounced.
  // The suppression store is populated by scanForBounces() on every run, so this
  // filter prevents the pipeline from re-sending to known-bad addresses indefinitely.
  const bouncedAddresses = getBouncedAddressSet();
  if (bouncedAddresses.size > 0) {
    const preFilterCount = targetEmails.length;
    targetEmails = targetEmails.filter(email => {
      if (bouncedAddresses.has(email)) {
        vLog(`[EMAIL ENGINE] [BOUNCE SUPPRESSION] Skipping known-bounced address: ${email}`);
        return false;
      }
      return true;
    });
    const suppressed = preFilterCount - targetEmails.length;
    if (suppressed > 0) {
      vLog(`[EMAIL ENGINE] [BOUNCE SUPPRESSION] Suppressed ${suppressed} previously-bounced address(es). ${targetEmails.length} target(s) remaining.`);
    }
  }

  if (targetEmails.length === 0) {
    vLog(`[EMAIL ENGINE] [FATAL] Route resolution failed. No active destinations.`);
    if (initialEmailsCount > 0) {
      throw new Error(`All candidate email routes were suppressed due to previous bounces: ${initialEmails.join(', ')}`);
    } else {
      throw new Error('Missing or invalid Application Email.');
    }
  }

  const to = targetEmails.join(', ');
  const subject = buildApplicationEmailSubject(metadata, config);
  const plainBody = formatCoverLetterPlaintext(fullCoverLetterText);
  const htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #202124;">${formatCoverLetterHtml(fullCoverLetterText)}</div>`;
  
  vLog(`[EMAIL ENGINE] Destination targets mapped: "${to}"`);
  vLog(`[EMAIL ENGINE] Subject heading compiled: "${subject}"`);

  // Use configured sender only if Gmail permits it; otherwise degrade safely to default sender.
  const options = { 
    name: config.applicantName, 
    replyTo: config.applicantEmail, 
    htmlBody 
  };
  if (canUseGmailFromAddress(config.applicantEmail)) {
    options.from = config.applicantEmail;
  } else if (STRICT_GMAIL_FROM_VALIDATION) {
    throw new Error(`Configured APPLICANT_EMAIL is not an authorized Gmail From address: ${config.applicantEmail}`);
  } else {
    vLog(`[EMAIL ENGINE] [WARNING] Configured APPLICANT_EMAIL is not an authorized Gmail From alias. Using account default sender and preserving replyTo.`);
  }
  
  if (ATTACH_RESUME_PDF && resumeFile) {
    vLog(`[EMAIL ENGINE] Packing file attachment target: "${resumeFile.getName()}" as PDF.`);
    options.attachments =[resumeFile.getAs(MimeType.PDF).setName(`${safeFilename(resumeFile.getName())}.pdf`)];
  }

  if (AUTO_SEND_EMAILS) {
    vLog('[EMAIL ENGINE] AUTO_SEND_EMAILS configured to TRUE. Shipping immediately...');
    try {
      GmailApp.sendEmail(to, subject, plainBody, options);
      vLog('[EMAIL ENGINE] Mail sent successfully.');
      return { getId: () => 'SENT_AUTOMATICALLY', isSent: true, targetEmails, from: options.from || '' };
    } catch (sendError) {
      vLog(`[EMAIL ENGINE] [WARNING] Bulk send failed ("${sendError.message}"). Attempting per-recipient dispatch...`);
      const successfulEmails = [];
      const failedEmails = [];

      targetEmails.forEach(singleEmail => {
        try {
          GmailApp.sendEmail(singleEmail, subject, plainBody, options);
          successfulEmails.push(singleEmail);
          vLog(`[EMAIL ENGINE] Successfully sent email to: ${singleEmail}`);
        } catch (singleErr) {
          failedEmails.push(`${singleEmail}: ${singleErr.message}`);
          vLog(`[EMAIL ENGINE] Failed sending email to ${singleEmail}: ${singleErr.message}`);
        }
      });

      if (successfulEmails.length > 0) {
        return { getId: () => 'SENT_AUTOMATICALLY', isSent: true, targetEmails: successfulEmails, from: options.from || '' };
      }
      throw new Error(`Email send failed for all recipients: ${failedEmails.join('; ')}`);
    }
  } else {
    vLog('[EMAIL ENGINE] AUTO_SEND_EMAILS configured to FALSE. Composing Gmail Draft inside target accounts...');
    try {
      const draft = GmailApp.createDraft(to, subject, plainBody, options);
      draft.isSent = false;
      draft.targetEmails = targetEmails;
      draft.from = options.from || '';
      vLog(`[EMAIL ENGINE] Gmail Draft compiled successfully. Draft ID: ${draft.getId()}`);
      return draft;
    } catch (draftError) {
      vLog(`[EMAIL ENGINE] [WARNING] Bulk draft creation failed ("${draftError.message}"). Attempting per-recipient draft creation...`);
      const successfulDrafts = [];
      const failedEmails = [];
      let lastDraft = null;

      targetEmails.forEach(singleEmail => {
        try {
          const singleDraft = GmailApp.createDraft(singleEmail, subject, plainBody, options);
          successfulDrafts.push(singleEmail);
          lastDraft = singleDraft;
          vLog(`[EMAIL ENGINE] Successfully created draft for: ${singleEmail}`);
        } catch (singleErr) {
          failedEmails.push(`${singleEmail}: ${singleErr.message}`);
          vLog(`[EMAIL ENGINE] Failed creating draft for ${singleEmail}: ${singleErr.message}`);
        }
      });

      if (successfulDrafts.length > 0 && lastDraft) {
        lastDraft.isSent = false;
        lastDraft.targetEmails = successfulDrafts;
        lastDraft.from = options.from || '';
        return lastDraft;
      }
      throw new Error(`Gmail draft creation failed for all recipients: ${failedEmails.join('; ')}`);
    }
  }
}

function buildApplicationEmailSubject(metadata, config) {
  const jobTitle = oneLinePlainText(getBestJobTitle(metadata));
  const jobId = oneLinePlainText(getMetadataValue(metadata, 'Job ID'));
  let subject = jobTitle ? `${jobTitle} Application — ${config.applicantName}` : `Application — ${config.applicantName}`;
  if (jobId) subject += ` — ${jobId}`;
  return truncateSubject(subject, 160);
}

function formatCoverLetterPlaintext(text) {
  return decodeCommonHtmlEntities(String(text || '')).replace(/\r\n?/g, '\n').replace(/<[^>]+>/g, '').trim();
}

function formatCoverLetterHtml(text) {
  return String(text || '').split(/\n{2,}/).map(p => {
    if (!p.trim()) return '';
    const escaped = escapeHtml(p).replace(/\n/g, '<br>');
    return `<p style="margin-bottom: 1.2em; line-height: 1.5; margin-top: 0;">${escaped}</p>`;
  }).filter(Boolean).join('\n');
}

function normalizeDiscoveryTier(tier) {
  const normalized = String(tier || '').trim().toUpperCase();
  if (!normalized) return '';
  if (DISCOVERY_TIERS[normalized]) return DISCOVERY_TIERS[normalized];
  if (/application|resume/.test(normalized.toLowerCase())) return DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE;
  return '';
}

function classifyCandidateTier(email, context) {
  const localPart = getEmailLocalPart(email);
  if (/^(careers?|jobs?|apply|resume|cv)$/i.test(localPart)) return DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE;
  if (isRecruitingOrCareerLocalPart(localPart)) return DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT;
  return DISCOVERY_TIERS.OTHER_PUBLIC_ROUTE;
}

function isRecruitingOrCareerLocalPart(localPart) {
  return /^(careers?|jobs?|apply|resume|recruiting|talent|hr|people)$/i.test(String(localPart || '').trim());
}

function normalizeSourceType(sourceType) {
  const value = String(sourceType || '').trim().toLowerCase();
  if (/ats|workday|greenhouse|lever|ashby|smartrecruiters/.test(value))          return 'ats_page';
  if (/career|careers|hiring[-_\s]?page/.test(value))                             return 'official_careers_page';
  if (/job[_\s-]?posting|job[_\s-]?page|posting/.test(value))                     return 'official_job_posting';
  if (/official[_\s-]?site|company|homepage|website/.test(value))                 return 'official_company_page';
  if (/third.?party|aggregator/.test(value))                                       return 'third_party';
  if (/professional|linkedin|recruiter|people[_\s-]?profile/.test(value))         return 'public_professional_page';
  if (/heuristic|pattern|synthetic/.test(value))                                   return 'heuristic_pattern';
  if (/manual|provided/.test(value))                                               return 'manual';
  return 'unknown';
}

function getSuppressionReasonForEmail(email, context) {
  if (!email || !isValidEmailAddress(email)) return 'Invalid email.';
  const localPart = getEmailLocalPart(email);
  if (/(no-reply|noreply|donotreply|privacy|abuse|legal|billing|press|media|investor|postmaster|webmaster|security|accommodation|accessibility|sales)/.test(localPart)) {
    return `Suppressed local part: ${localPart}`;
  }
  return '';
}

function parseConfidenceScore(value) {
  const number = Number(String(value).replace('%', '')) || 0;
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function parseScoreTo100(value) {
  const number = Number(String(value).replace('%', '')) || 0;
  return number <= 1 && number > 0 ? Math.round(number * 100) : Math.max(0, Math.min(100, Math.round(number)));
}

function tierRank(tier) {
  if (tier === DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE) return 5;
  if (tier === DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT) return 4;
  if (tier === DISCOVERY_TIERS.OFFICIAL_GENERAL_CONTACT) return 3;
  if (tier === DISCOVERY_TIERS.PUBLIC_RECRUITER_OR_HIRING_TEAM) return 2;
  if (tier === DISCOVERY_TIERS.OTHER_PUBLIC_ROUTE) return 1;
  return 0;
}

function detectAtsPlatform(url) {
  const text = String(url || '').toLowerCase();
  if (text.includes('workday')) return 'Workday';
  if (text.includes('greenhouse')) return 'Greenhouse';
  if (text.includes('lever')) return 'Lever';
  if (text.includes('ashby')) return 'Ashby';
  if (text.includes('smartrecruiters')) return 'SmartRecruiters';
  return '';
}

/**
 * Single-Pass Template Replacement Engine.
 */
function applyTemplateReplacements(doc, replacements) {
  vLog(`[TEMPLATE ENGINE] Initializing single-pass text replacements...`);
  const containers =[doc.getHeader(), doc.getBody(), doc.getFooter()].filter(Boolean);
  containers.forEach((container, containerIdx) => {
    vLog(`  - [TEMPLATE ENGINE] Parsing container zone #${containerIdx + 1}`);
    for (const [literal, replacement] of Object.entries(replacements)) {
      replaceAllLiteralText(container, literal, replacement);
    }
  });
}

function generateResumeDoc(resumeTemplate, targetFolder, metadata) {
  const manualResumeName = getMetadataValue(metadata, 'Resume Filename') || getMetadataValue(metadata, 'Materials Filename');
  const resumeName = manualResumeName ? manualResumeName : `${getMetadataValue(metadata, 'Job ID')} - Resume for ${getMetadataValue(metadata, 'Company')}`;
  
  vLog(`[RESUME GENERATOR] Manual Name Check: ${manualResumeName ? 'Found Name Override: ' + manualResumeName : 'Not found. Defaulting to standard metadata layout.'}`);
  vLog(`[RESUME GENERATOR] target file name verified: "${resumeName}"`);
  
  if (REUSE_EXISTING_GENERATED_FILES) {
    const existing = findFileByExactNameInFolder(targetFolder, resumeName);
    if (existing) {
      vLog(`[RESUME GENERATOR] Reuse flags enabled. Found matching template match ID: ${existing.getId()}`);
      return existing;
    }
  }

  vLog(`[RESUME GENERATOR] Replicating Template ID: ${resumeTemplate.getId()}`);
  const newResumeFile = resumeTemplate.makeCopy(resumeName, targetFolder);
  const newResumeDoc = DocumentApp.openById(newResumeFile.getId());
  vLog(`[RESUME GENERATOR] Copied custom instance. Doc ID: ${newResumeFile.getId()}`);

  const replacements = {};
  replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_PROF_TITLE] = getMetadataValue(metadata, 'Professional Title');
  replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_PROF_SUMMARY] = getMetadataValue(metadata, 'Professional Summary');
  replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_SKILLS] = getMetadataValue(metadata, 'Key Skills');
  
  const jobUrl = getMetadataValue(metadata, 'Job URL');

  // Defer clearing JOB_URL if we intend to inject a hyperlink there
  if (!jobUrl || !INCLUDE_VISIBLE_JOB_URL_IN_RESUME) {
    replacements[TEMPLATE_PLACEHOLDERS.JOB_URL] = ''; 
  }

  applyTemplateReplacements(newResumeDoc, replacements);

  if (jobUrl && INCLUDE_VISIBLE_JOB_URL_IN_RESUME) {
    vLog('[RESUME GENERATOR] Injecting visible Job URL into Resume...');
    replaceFirstLiteralTextWithLinkEverywhere(newResumeDoc, TEMPLATE_PLACEHOLDERS.JOB_URL, VISIBLE_JOB_URL_LABEL, jobUrl);
  }
  assertTemplatePlaceholdersResolved(newResumeDoc, 'Resume');

  vLog('[RESUME GENERATOR] Normalizing and removing parsing star markers...');
  removeStarLabels(newResumeDoc.getBody());
  normalizeResumeHeaderTop(newResumeDoc);
  
  newResumeDoc.saveAndClose();
  vLog('[RESUME GENERATOR] File saved and locked.');
  return newResumeFile;
}

function generateCoverLetterDoc(coverTemplate, targetFolder, metadata, coverLetterContent) {
  const manualCoverName = getMetadataValue(metadata, 'Cover Letter Filename');
  const coverName = manualCoverName ? manualCoverName : `${getMetadataValue(metadata, 'Job ID')} - Cover Letter for ${getMetadataValue(metadata, 'Company')}`;
  
  vLog(`[COVER LETTER GENERATOR] Manual Name Check: ${manualCoverName ? 'Found Name Override: ' + manualCoverName : 'Not found. Defaulting to standard metadata layout.'}`);
  vLog(`[COVER LETTER GENERATOR] Target file name verified: "${coverName}"`);
  
  let newCoverFile;

  if (REUSE_EXISTING_GENERATED_FILES) {
    newCoverFile = findFileByExactNameInFolder(targetFolder, coverName);
    if (newCoverFile) vLog(`[COVER LETTER GENERATOR] Reuse tags match. Found Cover Letter template ID: ${newCoverFile.getId()}`);
  }

  if (!newCoverFile) {
    vLog(`[COVER LETTER GENERATOR] Replicating Cover Letter Template ID: ${coverTemplate.getId()}`);
    newCoverFile = coverTemplate.makeCopy(coverName, targetFolder);
    const newCoverDoc = DocumentApp.openById(newCoverFile.getId());
    vLog(`[COVER LETTER GENERATOR] Copied custom instance. Doc ID: ${newCoverFile.getId()}`);

    const replacements = {};
    replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_PROF_TITLE] = getMetadataValue(metadata, 'Professional Title');
    replacements[TEMPLATE_PLACEHOLDERS.TODAYS_DATE] = getTodaysDateString();
    replacements[TEMPLATE_PLACEHOLDERS.JOB_COMPANY_ADDRESS] = getMetadataValue(metadata, 'Company Address');
    replacements[TEMPLATE_PLACEHOLDERS.JOB_COMPANY] = getMetadataValue(metadata, 'Company');
    replacements[TEMPLATE_PLACEHOLDERS.COVER_BODY] = coverLetterContent || '';

    applyTemplateReplacements(newCoverDoc, replacements);
    assertTemplatePlaceholdersResolved(newCoverDoc, 'Cover Letter');
    const coverText = getFullDocumentText(newCoverDoc);
    newCoverDoc.saveAndClose();
    vLog('[COVER LETTER GENERATOR] File saved and locked.');
    return { file: newCoverFile, text: coverText };
  }

  return { file: newCoverFile, text: getFullDocumentText(DocumentApp.openById(newCoverFile.getId())) };
}

/**
 * Extracts the trailing segment of the manual file name.
 */
function getRearJobTitlePortion(metadata) {
  const resumeFilename = getMetadataValue(metadata, 'Resume Filename') || getMetadataValue(metadata, 'Materials Filename');
  const coverFilename = getMetadataValue(metadata, 'Cover Letter Filename');
  const sourceName = resumeFilename || coverFilename;
  
  if (!sourceName) {
    // Structural fallback: Use Job ID or compressed job title
    const jobId = getMetadataValue(metadata, 'Job ID');
    if (jobId) return jobId;
    const jobTitle = getBestJobTitle(metadata);
    return jobTitle ? jobTitle.replace(/[^a-zA-Z0-9]/g, '') : 'Job';
  }
  
  // Matches trailing characters after _Resume_ or _Cover_ or _Materials_
  const match = sourceName.match(/_(?:Resume|Cover|Materials)_(.+)$/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  
  // Secondary fallback: Extract final string split by underscore
  const parts = sourceName.split('_');
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (!/^(resume|cover|materials)$/i.test(last)) {
      return last.trim();
    }
  }
  return sourceName;
}

/**
 * Generates the third output file containing the LinkedIn posting URL.
 */
function generateLinkedInDoc(targetFolder, metadata, jobUrl) {
  const rearPortion = getRearJobTitlePortion(metadata);
  const linkedInFileName = `REDACTED_NAME_LinkedIn_${rearPortion}`;
  vLog(`[LINKEDIN DOC GENERATOR] Preparing creation of: "${linkedInFileName}"...`);
  
  if (REUSE_EXISTING_GENERATED_FILES) {
    const existing = findFileByExactNameInFolder(targetFolder, linkedInFileName);
    if (existing) {
      vLog(`[LINKEDIN DOC GENERATOR] Reusing existing generated LinkedIn Doc ID: ${existing.getId()}`);
      return existing;
    }
  }

  // Create temporary document container in root and shift to target folder
  const newDoc = DocumentApp.create(linkedInFileName);
  const body = newDoc.getBody();
  
  body.appendParagraph("LinkedIn Job Posting URL:").setBold(true);
  const linkParagraph = body.appendParagraph(jobUrl);
  linkParagraph.setLinkUrl(jobUrl);
  newDoc.saveAndClose();

  const file = DriveApp.getFileById(newDoc.getId());
  file.moveTo(targetFolder);
  
  vLog(`[LINKEDIN DOC GENERATOR] New Doc generated and shifted to target folder. Doc ID: ${file.getId()}`);
  return file;
}

function findFileByExactNameInFolder(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  return files.hasNext() ? files.next() : null;
}

function removeStarLabels(body) {
  ['Situation: ', 'Task: ', 'Action: ', 'Result: '].forEach(label => replaceAllLiteralText(body, label, ''));
}

function normalizeResumeHeaderTop(doc) {
  [doc.getHeader(), doc.getBody()].filter(Boolean).forEach(container => {
    if (STRIP_LINKEDIN_FROM_RESUME_HEADER) {
      removeLinkedInFromTopContainer(container, 15);
    }
    cleanupTopHeaderSeparators(container, 15);
  });
}

function assertTemplatePlaceholdersResolved(doc, templateName) {
  if (!REQUIRE_TEMPLATE_PLACEHOLDER_COMPLETION) return;
  const unresolved = [];
  const placeholders = Object.values(TEMPLATE_PLACEHOLDERS);
  const containers = [doc.getHeader(), doc.getBody(), doc.getFooter()].filter(Boolean);

  containers.forEach(container => {
    placeholders.forEach(placeholder => {
      const found = container.findText(escapeRegex(placeholder));
      if (found && unresolved.indexOf(placeholder) === -1) unresolved.push(placeholder);
    });
  });

  if (unresolved.length > 0) {
    throw new Error(`Template placeholder(s) unresolved in ${templateName}: ${unresolved.join(', ')}`);
  }
}

function removeLinkedInFromTopContainer(container, maxChildren) {
  const limit = Math.min(container.getNumChildren(), maxChildren);
  for (let i = 0; i < limit; i++) {
    const child = container.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const text = child.editAsText();
      LINKEDIN_PATTERNS.forEach(pattern => {
        try { text.replaceText(pattern, ' '); } catch (e) {}
      });
    }
  }
}

function cleanupTopHeaderSeparators(container, maxChildren) {
  const limit = Math.min(container.getNumChildren(), maxChildren);
  for (let i = 0; i < limit; i++) {
    const child = container.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const text = child.editAsText();
      SEPARATOR_PATTERNS.forEach(p => {
        try { text.replaceText(p.search, p.replace); } catch (e) {}
      });
    }
  }
}

function shouldProcessSourceMaterialFile(file) {
  const name = String(file.getName() || '').toLowerCase();
  return /\.(md|markdown|txt)$/.test(name) || file.getMimeType() === MimeType.PLAIN_TEXT;
}

function getRequiredDeploymentConfig() {
  if (ENABLE_DOC_LOGGING && !DOC_LOG_FOLDER_ID) {
    throw new Error('DOC_LOG_FOLDER_ID must be configured when ENABLE_DOC_LOGGING is true.');
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const config = {
    sourceFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.SOURCE_FOLDER_ID),
    targetFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.TARGET_FOLDER_ID),
    processedFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.PROCESSED_FOLDER_ID),
    resumeTemplateId: scriptProperties.getProperty(SCRIPT_PROPERTIES.RESUME_TEMPLATE_ID),
    coverTemplateId: scriptProperties.getProperty(SCRIPT_PROPERTIES.COVER_LETTER_TEMPLATE_ID),
    orApiKey: scriptProperties.getProperty(SCRIPT_PROPERTIES.OR_API_KEY), // Updated: poeApiKey -> orApiKey / POE_API_KEY -> OR_API_KEY
    spreadsheetLogId: scriptProperties.getProperty(SCRIPT_PROPERTIES.SPREADSHEET_LOG_ID),
    applicantName: scriptProperties.getProperty(SCRIPT_PROPERTIES.APPLICANT_NAME),
    applicantEmail: scriptProperties.getProperty(SCRIPT_PROPERTIES.APPLICANT_EMAIL)
  };

  const requiredKeys = [
    'sourceFolderId',
    'targetFolderId',
    'processedFolderId',
    'resumeTemplateId',
    'coverTemplateId',
    'orApiKey',
    'applicantName'
  ];
  if (ENABLE_EMAIL_DISPATCH) requiredKeys.push('applicantEmail');
  if (ENABLE_SPREADSHEET_LOGGING) requiredKeys.push('spreadsheetLogId');

  const missing = requiredKeys.filter(key => !config[key]);
  if (missing.length > 0) throw new Error(`Missing Script Properties: ${missing.join(', ')}.`);
  return config;
}

/**
 * Main deployment orchestrator (Time-Chunked).
 */
function deployMaterials() {
  const startTime = Date.now();
  const MAX_EXECUTION_MS = 5 * 60 * 1000; // 5 minutes (Google limit is 6)

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    vLog('[ORCHESTRATOR] [FATAL] Lock access execution failed. Another script run is locking process.');
    flushDocLogs();
    throw new Error('Could not acquire script lock.');
  }

  try {
    vLog('[ORCHESTRATOR] Script lock claimed. Starting execution engine pass...');
    PropertiesService.getScriptProperties().deleteProperty(CONTINUATION_TRIGGER_GUARD_PROP);
    const config = getRequiredDeploymentConfig();
    const sourceFolder = DriveApp.getFolderById(config.sourceFolderId);
    const targetFolder = DriveApp.getFolderById(config.targetFolderId);
    const processedFolder = DriveApp.getFolderById(config.processedFolderId);
    const resumeTemplate = DriveApp.getFileById(config.resumeTemplateId);
    const coverTemplate = DriveApp.getFileById(config.coverTemplateId);
    const materialFiles = sourceFolder.getFiles();

    vLog(`[ORCHESTRATOR] Folders identified. Source Folder ID: ${config.sourceFolderId}, Target Folder ID: ${config.targetFolderId}`);

    try {
      preflightGmailDraftAuthorization(config);
    } catch (e) {
      vLog(`[ORCHESTRATOR] [WARNING] Gmail preflight check exception: ${e.message}`);
    }

    try {
      preflightSpreadsheetAuthorization(config);
    } catch (e) {
      vLog(`[ORCHESTRATOR] [WARNING] Spreadsheet preflight check exception: ${e.message}`);
    }

    // Auto-scan for bounce backs before calculating processed jobs
    scanForBounces(config);
    syncBouncedAddressesFromSheet(config);

    const processedJobIds = getProcessedJobIds(config);

    while (materialFiles.hasNext()) {
      if (Date.now() - startTime > MAX_EXECUTION_MS) {
        vLog('[ORCHESTRATOR] ⏳ Execution window near maximum safe threshold. Scheduling trigger loop for next run...');
        scheduleDeployMaterialsContinuationTrigger();
        break;
      }

      const file = materialFiles.next();
      if (!shouldProcessSourceMaterialFile(file)) {
        vLog(`[ORCHESTRATOR] File: "${file.getName()}" does not match criteria. Skipping.`);
        continue;
      }

      try {
        processSingleMaterialFile({ file, targetFolder, processedFolder, resumeTemplate, coverTemplate, processedJobIds, config });
      } catch (e) {
        vLog(`[ORCHESTRATOR] [ERROR] Failed processing loop target "${file.getName()}": ${e.message}`);
      }
      
      // Flush logs after processing each file to ensure safe state
      flushDocLogs();
    }
    vLog('[ORCHESTRATOR] 🏁 Deployment loop finalized.');
  } catch (err) {
    vLog(`[ORCHESTRATOR] [FATAL] execution halted: ${err.message}`);
    throw err;
  } finally {
    lock.releaseLock();
    vLog('[ORCHESTRATOR] Release execution lock safely.');
    // Final flush to catch any remaining logs
    flushDocLogs();
  }
}

/**
 * Processes one source material file.
 */
function processSingleMaterialFile(params) {
  const { file, targetFolder, processedFolder, resumeTemplate, coverTemplate, processedJobIds, config } = params;
  let shouldMoveSourceFile = MOVE_SOURCE_FILE_AFTER_SUCCESS;
  let hasLoggedFailure = false;
  let discoveryResult = null;

  vLog(`========================================================`);
  vLog(`📥 Loading Material File: ${file.getName()} (ID: ${file.getId()})`);

  let parsed;
  try {
    parsed = parseMarkdown(file.getBlob().getDataAsString());
  } catch (e) {
    vLog(`  - ❌ [PARSER ERROR] Failed to parse material file "${file.getName()}": ${e.message}`);
    appendToSpreadsheetLog({
      status: 'PARSER_FAILED',
      company: '',
      jobId: '',
      jobTitle: file.getName(),
      targetEmail: '',
      emailTier: '',
      score: '',
      messageId: `ERROR: ${truncateText(e.message || 'Parse error', 150)}`,
      jobUrl: ''
    }, config);
    return;
  }

  const metadata = parsed.metadata;
  const companyName = getMetadataValue(metadata, 'Company');
  const jobId = getMetadataValue(metadata, 'Job ID');

  vLog(`  - [CORE] Parsed Company Target: "${companyName}" | Resolved Job ID: "${jobId}"`);

  if (jobId && processedJobIds.has(jobId)) {
    vLog(`  - [CORE] Record match: Job ID ${jobId} was already successfully executed. Skipping duplicates.`);
    if (shouldMoveSourceFile) {
      file.moveTo(processedFolder);
      vLog(`  - [CORE] Source file safely archived.`);
    }
    return;
  }

  try {
    vLog('  - [CORE] Querying OpenRouter API intelligence...');
    discoveryResult = discoverApplicationEmailRoutes(metadata, config);

    if (
      (REQUIRE_EMAIL_DISCOVERY_SUCCESS_WHEN_DRAFTING || REQUIRE_DRAFT_SUCCESS_FOR_DRAFTABLE_EMAIL) &&
      ENABLE_EMAIL_DISPATCH &&
      APPLICATION_DRAFT_MODE !== 'OFF' &&
      !discoveryResult.shouldCreateDraft
    ) {
      appendToSpreadsheetLog({
        status: LOG_STATUS_NO_DRAFTABLE_ROUTE,
        company: companyName,
        jobId: jobId,
        jobTitle: getBestJobTitle(metadata),
        targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
        emailTier: LOG_EMAIL_TIER_NO_DRAFTABLE_ROUTE,
        score: discoveryResult.score || '',
        messageId: '',
        jobUrl: getMetadataValue(metadata, 'Job URL')
      }, config);
      hasLoggedFailure = true;
      throw new Error('No draftable email route found under strict discovery requirement. Source file retained for retry.');
    }

    // Use LLM-extracted address, fallback to manual file, fallback to standalone LLM call
    let companyAddress = discoveryResult.companyMailingAddress || getMetadataValue(metadata, 'Company Address');
    if (!companyAddress) {
      vLog('  - [CORE] Address block empty in main payload. Fetching standalone HQ lookup...');
      companyAddress = fetchCompanyAddress(companyName, metadata, config);
    }
    
    // Format Corporate address blocks dynamically with [Manager Name/Dept], [Company], [Address]
    companyAddress = formatCorporateHQAddressBlock(metadata, companyAddress, companyName);
    metadata['Company Address'] = companyAddress;
    vLog(`  - [CORE] Finalized Corporate HQ Address Block mapped to Metadata:\n${companyAddress}`);

    const newResumeFile = generateResumeDoc(resumeTemplate, targetFolder, metadata);
    const coverDocResult = generateCoverLetterDoc(coverTemplate, targetFolder, metadata, parsed.content);
    
    // Generate the third output file mapping the clickable LinkedIn URL
    const jobUrl = getMetadataValue(metadata, 'Job URL');
    let linkedInFile = null;
    if (jobUrl) {
      linkedInFile = generateLinkedInDoc(targetFolder, metadata, jobUrl);
    } else {
      vLog(`  - [CORE] [WARNING] Job URL parameter missing. Bypassing LinkedIn Doc generation.`);
    }
    
    associateApplicationEmailDiscovery(metadata, discoveryResult);
    
    // Consolidate output files for metadata annotation properties
    const filesToAnnotate = [newResumeFile, coverDocResult.file];
    if (linkedInFile) {
      filesToAnnotate.push(linkedInFile);
    }
    annotateGeneratedFilesWithApplicationEmail(filesToAnnotate, metadata, discoveryResult);

    if (discoveryResult.shouldCreateDraft) {
      vLog(`  - [CORE] Valid target endpoint routes mapped. Executing delivery mechanisms...`);
      const dispatchResult = dispatchApplicationEmail(metadata, coverDocResult.text, newResumeFile, discoveryResult, config);
      
      // Create granular arrays mapping 1:1 to the target emails
      const statusArray = dispatchResult.targetEmails.map(() => dispatchResult.isSent ? 'SENT' : 'DRAFTED');
      const tierArray = dispatchResult.targetEmails.map(email => {
        const cand = discoveryResult.candidates.find(c => c.email === email);
        return cand ? cand.tier : 'UNKNOWN';
      });

      appendToSpreadsheetLog({
        status: statusArray.join(', '),
        company: companyName, 
        jobId: jobId, 
        jobTitle: getBestJobTitle(metadata),
        targetEmail: dispatchResult.targetEmails.join(', '), 
        emailTier: tierArray.join(', '),
        score: discoveryResult.score, // Highest score
        messageId: dispatchResult.getId(),
        jobUrl: getMetadataValue(metadata, 'Job URL')
      }, config);
      
      vLog(`  - 🚀 Dispatch loop successfully finalized: ${dispatchResult.isSent ? 'SENT' : 'DRAFTED'} to ${dispatchResult.targetEmails.length} recipients.`);
    } else {
      vLog(`  - 🛑 Routing criteria validation failed. Dispatch bypass active.`);
      appendToSpreadsheetLog({
        status: LOG_STATUS_NO_DRAFTABLE_ROUTE,
        company: companyName,
        jobId: jobId,
        jobTitle: getBestJobTitle(metadata),
        targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
        emailTier: LOG_EMAIL_TIER_NO_DRAFTABLE_ROUTE,
        score: discoveryResult.score || '',
        messageId: '',
        jobUrl: getMetadataValue(metadata, 'Job URL')
      }, config);
    }

  } catch (e) {
    const isSuppressedBounce = e.message && e.message.includes('suppressed due to previous bounces');
    if (!hasLoggedFailure) {
      appendToSpreadsheetLog({
        status: isSuppressedBounce ? LOG_STATUS_SUPPRESSED_BOUNCE : LOG_STATUS_DISPATCH_FAILED,
        company: companyName,
        jobId: jobId,
        jobTitle: getBestJobTitle(metadata),
        targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
        emailTier: isSuppressedBounce ? LOG_EMAIL_TIER_SUPPRESSED_BOUNCE : LOG_EMAIL_TIER_DISPATCH_FAILED,
        score: discoveryResult && discoveryResult.score ? discoveryResult.score : '',
        messageId: `ERROR: ${truncateText(e.message || 'Unknown error', 150)}`,
        jobUrl: getMetadataValue(metadata, 'Job URL')
      }, config);
    }
    vLog(`  - ❌ [CORE ERROR] Pipeline execution failed: ${e.message}`);
    if (isSuppressedBounce) {
      vLog(`  - [CORE] Archiving file since retry will not bypass bounce suppression store.`);
      shouldMoveSourceFile = true;
    } else {
      shouldMoveSourceFile = false;
    }
  }

  if (shouldMoveSourceFile) {
    file.moveTo(processedFolder);
    vLog('  - [CORE] Source markdown archived to processed folder.');
  }
}

function getDispatchTargetEmailsForLogging(metadata, discoveryResult) {
  const candidateEmails = asArray(discoveryResult && discoveryResult.candidates)
    .filter(c => c && c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .map(c => sanitizeEmailAddress(c.email))
    .filter(Boolean);

  if (candidateEmails.length > 0) return [...new Set(candidateEmails)];

  const fallback = sanitizeEmailAddress(getMetadataValue(metadata, 'Application Email'));
  return fallback ? [fallback] : [];
}

function getMetadataValue(metadata, key) {
  return metadata && metadata[key] ? String(metadata[key]).trim() : '';
}

function getNormalizedGmailAliases() {
  if (CACHED_GMAIL_ALIASES !== null) return CACHED_GMAIL_ALIASES;
  try {
    CACHED_GMAIL_ALIASES = GmailApp.getAliases().map(a => sanitizeEmailAddress(a)).filter(Boolean);
    return CACHED_GMAIL_ALIASES;
  } catch (e) {
    return [];
  }
}

function canUseGmailFromAddress(address) {
  const normalized = sanitizeEmailAddress(address);
  if (!normalized) return false;

  if (CACHED_EFFECTIVE_USER_EMAIL === null) {
    try {
      CACHED_EFFECTIVE_USER_EMAIL = sanitizeEmailAddress(Session.getEffectiveUser().getEmail());
    } catch (e) {
      CACHED_EFFECTIVE_USER_EMAIL = '';
    }
  }

  if (CACHED_EFFECTIVE_USER_EMAIL && normalized === CACHED_EFFECTIVE_USER_EMAIL) return true;

  const aliases = getNormalizedGmailAliases();
  return aliases.includes(normalized);
}

function getBestJobTitle(metadata) {
  return getMetadataValue(metadata, 'Job Title') || getMetadataValue(metadata, 'Role Title');
}

function asArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function sanitizeEmailAddress(value) {
  return String(value || '').trim().replace(/^mailto:/i, '').replace(/[<>()"'`,;\s]+/g, '').toLowerCase();
}

function isValidEmailAddress(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function getEmailLocalPart(email) {
  return String(email || '').split('@')[0].toLowerCase();
}

function sanitizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(null|none|n\/a|na|unknown)$/i.test(raw)) return '';

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return '';
    return parsed.toString();
  } catch (e) {
    return '';
  }
}

function extractDomainFromUrl(value) {
  try {
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return normalizeDomain(new URL(url).hostname);
  } catch (e) { return ''; }
}

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function domainMatchesOrSubdomain(emailDomain, canonicalDomain) {
  return emailDomain && canonicalDomain && (emailDomain === canonicalDomain || emailDomain.endsWith(`.${canonicalDomain}`));
}

function domainLooksLikePublicEmailProvider(domain) {
  return['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'].includes(normalizeDomain(domain));
}

function oneLinePlainText(text) {
  return String(text || '').replace(/\r\n?/g, ' ').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim();
}

function cleanLlmText(value) {
  const text = oneLinePlainText(value);
  return /^(null|none|n\/a|na|unknown)$/i.test(text) ? '' : text;
}

function truncateSubject(subject, maxLength) {
  return subject.length <= maxLength ? subject : subject.substring(0, maxLength - 3) + '...';
}

function truncateText(text, maxLength) {
  return text.length <= maxLength ? text : text.substring(0, maxLength - 3) + '...';
}

function appendSentence(existing, addition) {
  if (!addition) return existing;
  if (!existing) return addition;
  return /(?:\.|!|\?)$/.test(existing) ? `${existing} ${addition}` : `${existing}. ${addition}`;
}

function safeFilename(value) {
  return String(value || 'attachment').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAllLiteralText(body, literal, replacement) {
  let searchResult = body.findText(escapeRegex(literal));
  while (searchResult) {
    const el = searchResult.getElement().asText();
    const start = searchResult.getStartOffset();
    const end = searchResult.getEndOffsetInclusive();
    
    if (replacement !== '') {
      vLog(`[REPLACE ENGINE] Replacing bracket marker "${literal}" with replacement text...`);
      // "Trojan Horse" insertion: Insert the new text *inside* the placeholder.
      // By inserting after the first character, we force Google Docs to inherit 
      // the exact formatting of the placeholder, completely bypassing hidden 
      // newline or paragraph styles that corrupt index 0 insertions.
      el.insertText(start + 1, replacement);
      
      // Delete the first character of the original placeholder
      el.deleteText(start, start);
      
      // Delete the rest of the original placeholder (if it was longer than 1 char)
      if (end > start) {
        el.deleteText(start + replacement.length, end + replacement.length - 1);
      }
    } else {
      vLog(`[REPLACE ENGINE] Cleaning empty placeholder key: "${literal}"`);
      el.deleteText(start, end);
    }
    
    searchResult = body.findText(escapeRegex(literal), searchResult);
  }
}

function replaceFirstLiteralTextWithLinkEverywhere(doc, literal, replacement, url) {
  [doc.getHeader(), doc.getBody(), doc.getFooter()].filter(Boolean).forEach((container, containerIdx) => {
    const searchResult = container.findText(escapeRegex(literal));
    if (searchResult) {
      vLog(`[LINK ENGINE] Inserting link target inside layout zone #${containerIdx + 1}...`);
      const el = searchResult.getElement().asText();
      const start = searchResult.getStartOffset();
      const end = searchResult.getEndOffsetInclusive();
      
      if (replacement) {
        // "Trojan Horse" insertion to preserve formatting
        el.insertText(start + 1, replacement);
        el.deleteText(start, start);
        
        if (end > start) {
          el.deleteText(start + replacement.length, end + replacement.length - 1);
        }
        
        // Apply the hyperlink to the newly inserted text
        el.setLinkUrl(start, start + replacement.length - 1, url);
        vLog(`[LINK ENGINE] Hyperlink URL attached successfully: "${url}"`);
      } else {
        el.deleteText(start, end);
      }
    }
  });
}

function decodeCommonHtmlEntities(text) {
  return String(text || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scheduleDeployMaterialsContinuationTrigger() {
  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const priorTs = Number(props.getProperty(CONTINUATION_TRIGGER_GUARD_PROP) || 0);
  if (priorTs > 0 && (now - priorTs) < CONTINUATION_TRIGGER_GUARD_WINDOW_MS) {
    vLog('[ORCHESTRATOR] Continuation trigger was recently scheduled. Skipping duplicate creation.');
    return;
  }
  ScriptApp.newTrigger('deployMaterials').timeBased().after(CONTINUATION_TRIGGER_DELAY_MS).create();
  props.setProperty(CONTINUATION_TRIGGER_GUARD_PROP, String(now));
  vLog(`[ORCHESTRATOR] Continuation trigger created (delay ${CONTINUATION_TRIGGER_DELAY_MS} ms).`);
}

function getTodaysDateString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'MMMM d, yyyy');
}

function getCurrentTimestampString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd HH:mm:ss');
}
