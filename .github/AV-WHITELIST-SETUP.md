# AV Whitelist Automation Setup

This document explains how to configure the automated AV vendor false positive submission system.

## Overview

The `av-scan.yml` workflow automatically:
1. Scans Windows release assets with VirusTotal
2. Generates file hashes (SHA256, SHA1, MD5)
3. Creates a GitHub issue with submission checklist
4. Optionally sends automated emails to AV vendors

## Required Secrets

### 1. VIRUSTOTAL_API_KEY (Required)

Get a free API key from [VirusTotal](https://www.virustotal.com/gui/join-us).

```bash
gh secret set VIRUSTOTAL_API_KEY --body "your-api-key-here"
```

### 2. AGENTMAIL_API_KEY (Optional - for email automation)

Required only if you want to send automated emails to AV vendors.

Using the CyberAgent/AgentMail API:

```bash
gh secret set AGENTMAIL_API_KEY --body "ca_your-api-key-here"
```

**Alternative Email Providers:**

If you want to use a different email provider, modify the workflow to use:
- **SendGrid**: `SENDGRID_API_KEY`
- **Mailgun**: `MAILGUN_API_KEY`
- **SMTP**: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`

## Usage

### Automatic Trigger

The workflow runs automatically when a release is published. It will:
- Scan all Windows assets
- Generate hashes
- Create a tracking issue

Emails are NOT sent automatically - they require manual trigger.

### Manual Trigger with Emails

To send automated emails to AV vendors:

```bash
gh workflow run av-scan.yml \
  --field tag=v0.8.1 \
  --field send_emails=true \
  --field priority_filter=high
```

### Priority Levels

| Priority | Vendors | When to Use |
|----------|---------|-------------|
| `critical` | Microsoft, Google | Always submit |
| `high` | Norton, McAfee, Kaspersky, Avast, AVG, Bitdefender, ESET | High user impact |
| `medium` | Trend Micro, Sophos, F-Secure, Avira, Fortinet, etc. | Moderate impact |
| `low` | K7, Ikarus, DrWeb, Tencent, Baidu, etc. | Low impact |

## Vendor Contacts

All vendor contacts are stored in `.github/av-vendor-contacts.json`.

Current stats:
- **25 vendors** with email submission
- **5 vendors** with web-only submission

### Updating Contacts

Edit `.github/av-vendor-contacts.json` to add or update vendors:

```json
{
  "name": "Vendor Name",
  "priority": "high",
  "email": "fp@vendor.com",
  "web_form": "https://vendor.com/submit",
  "notes": "Additional info"
}
```

## Workflow Outputs

### Artifacts

| Artifact | Description |
|----------|-------------|
| `virustotal-scan-report` | VirusTotal scan results |
| `av-submission-report` | File hashes and submission links |
| `email-submission-report` | Email sending status (if enabled) |

### GitHub Issue

A tracking issue is created with:
- File hashes
- Submission checklist
- Email template
- Links to all vendor portals

## Monitoring Responses

After sending emails, monitor:

1. **GitHub Issue**: Track manual submissions
2. **Email Inbox**: Check for vendor responses
3. **VirusTotal**: Re-scan after 7-14 days

Most vendors respond within:
- Microsoft: 1-3 business days
- Major vendors: 3-7 business days
- Smaller vendors: 1-4 weeks

## Troubleshooting

### Emails Not Sending

1. Check `AGENTMAIL_API_KEY` secret is set
2. Verify `send_emails` is `true`
3. Check workflow logs for errors

### Rate Limiting

The workflow includes a 2-second delay between emails to avoid rate limiting.

### Vendor Not Responding

Some vendors require:
- Web form submission (cannot automate)
- File attachment (email only sends hashes)
- Account login

Check the issue checklist and submit manually if needed.

## References

- [False Positive Center](https://github.com/yaronelh/False-Positive-Center)
- [VirusTotal FAQ](https://docs.virustotal.com/docs/false-positive)
- [Microsoft WDSI](https://www.microsoft.com/en-us/wdsi/filesubmission)
