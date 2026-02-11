# Windows SmartScreen Resolution Guide

This guide documents the process for resolving Windows SmartScreen warnings for ReactorPro releases.

## Understanding SmartScreen Warnings

### Blue Warning ("Windows protected your PC")
- **Cause**: Low reputation for unknown/new applications
- **User Action**: Click "More info" → "Run anyway"
- **Resolution**: Builds reputation over time with more downloads

### Red Warning ("This app has been blocked")
- **Cause**: Active detection as potentially dangerous OR administrator policy
- **Resolution**: Requires Microsoft submission and/or EV certificate

## Root Cause Analysis

ReactorPro uses a **standard OV (Organization Validation) code signing certificate** from Hyperspace Technologies. Key facts:

1. **OV certificates do NOT provide immediate SmartScreen trust** - only EV certificates historically did
2. **Even EV certificates no longer guarantee instant trust** - Microsoft updated their policies
3. **Electron/NSIS installers are frequently flagged** due to:
   - Generic behavioral patterns (auto-updaters, native modules)
   - Low initial reputation
   - NSIS installer characteristics

## Microsoft Submission Channels

### ⚠️ Important: Email Addresses Do NOT Work

The following Microsoft email addresses **all bounce** and should NOT be used:
- ~~windefend@microsoft.com~~
- ~~report@microsoft.com~~
- ~~wdsi@microsoft.com~~

Microsoft only accepts submissions via web forms.

### 1. Microsoft Security Intelligence (WDSI) - Primary

**URL**: https://www.microsoft.com/en-us/wdsi/filesubmission

**Steps**:
1. Go to the submission portal
2. Sign in with a Microsoft account
3. Select **"Software developer"** as the submission type
4. Upload the Windows executable (e.g., `reactorpro-X.X.X-setup.exe`)
5. Provide details:
   - **Company**: Hyperspace Technologies
   - **Product**: ReactorPro
   - **Description**: AI-powered coding assistant desktop application
   - **Website**: https://reactorpro.ng
   - **Code signing**: Valid OV certificate, expires January 21, 2036
   - **VirusTotal**: 0/94 malicious detections
6. Submit and note the case number

**Response Time**: Typically 1-5 business days

### 2. SmartScreen URL/App Reputation Submission

**URL**: https://www.microsoft.com/en-us/wdsi/AppRepSubmission

**Steps**:
1. Submit the download URL: `https://github.com/DrOlu/ReactorPro/releases/download/vX.X.X/reactorpro-X.X.X-setup.exe`
2. Select "I believe this URL or file should be trusted"
3. Provide company and contact information
4. Submit

### 3. SmartScreen Feedback Portal

**URL**: https://feedback.smartscreen.microsoft.com

Use this for reporting false positive website/URL blocks.

## Long-Term Solutions (Ranked by Effectiveness)

### 1. Azure Trusted Signing (Recommended) ⭐

**Cost**: $9.99/month
**Effectiveness**: Highest - Microsoft's own signing service gets immediate SmartScreen trust
**Timeline**: Days to weeks for setup

**Requirements**:
- Azure subscription
- Organization must have 3+ years of business history (for Identity Validation)
- US, Canada, or select other countries

**Benefits**:
- Immediate SmartScreen trust
- No hardware token required
- Integrates with CI/CD (GitHub Actions)
- HSM-backed key storage

**Setup**: https://learn.microsoft.com/en-us/azure/trusted-signing/

### 2. EV Code Signing Certificate

**Cost**: $400-700/year + hardware token
**Effectiveness**: High (but no longer instant SmartScreen bypass)
**Timeline**: 1-2 weeks for identity verification

**Providers**:
- DigiCert
- Sectigo
- GlobalSign

**Note**: As of 2023, EV certificates no longer provide automatic SmartScreen bypass. They still build reputation faster than OV certificates.

### 3. Reputation Building

**Cost**: Free
**Effectiveness**: Low to medium
**Timeline**: Weeks to months

**Actions**:
- Consistent releases from same certificate
- High download volume
- Manual Microsoft submissions for each release
- Positive user feedback through Windows Security

## Electron-Builder Configuration Improvements

Add these to `electron-builder.yml` for better SmartScreen compatibility:

```yaml
win:
  executableName: reactorpro
  icon: resources/icon.png
  # Add publisher information
  publisherName: "Hyperspace Technologies"
  # Ensure proper timestamping
  timeStampServer: "http://timestamp.digicert.com"
  # RFC3161 timestamp for longer validity
  rfc3161TimeStampServer: "http://timestamp.digicert.com"

nsis:
  artifactName: ${name}-${version}-setup.${ext}
  shortcutName: ${productName}
  uninstallDisplayName: ${productName}
  createDesktopShortcut: always
  # Add one-click installer option (simpler, sometimes better reputation)
  oneClick: false
  # Allow per-machine or per-user install
  perMachine: false
  allowToChangeInstallationDirectory: true
  # Include license
  license: LICENSE
```

## Checklist for Each Release

- [ ] Code sign the executable with valid certificate
- [ ] Verify signature: `signtool verify /pa /v reactorpro-X.X.X-setup.exe`
- [ ] Run VirusTotal scan
- [ ] Submit to WDSI (https://www.microsoft.com/en-us/wdsi/filesubmission)
- [ ] Submit download URL to AppRep (https://www.microsoft.com/en-us/wdsi/AppRepSubmission)
- [ ] Document case numbers in release notes

## Resources

- [Microsoft WDSI File Submission](https://www.microsoft.com/en-us/wdsi/filesubmission)
- [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/)
- [SmartScreen FAQ](https://support.microsoft.com/en-us/windows/smartscreen-faq-cf0c7c7f-a6c3-66ce-6016-3c56c27cc7e6)
- [Electron Code Signing Guide](https://www.electronjs.org/docs/latest/tutorial/code-signing)
