# Firefox Extension Installation Guide

## Quick Installation Steps

### 1. Generate Icon Files (Required)

Since Git is not suitable for storing binary files, PNG icons need to be generated first:

1. Open `firefox-extension/icons/generate-icons.html` in your browser
2. The page will automatically generate icon previews
3. Right-click each icon and select "Save Image As"
4. Save with the following filenames to the `firefox-extension/icons/` directory:
   - `icon-16.png`
   - `icon-32.png`
   - `icon-48.png`
   - `icon-128.png`

### 2. Install Extension to Firefox

#### Method 1: Developer Mode (Recommended, avoids 403 errors)

1. Open Firefox browser
2. Type in the address bar: `about:debugging`
3. Click "This Firefox" on the left
4. Click "Load Temporary Add-on" button
5. Navigate to the `firefox-extension` directory
6. Select the `manifest.json` file
7. Click "Open"

**Note**: This method will not encounter 403 Forbidden errors because it bypasses Firefox's signature verification.

The extension will be installed immediately and display an icon in the toolbar.

#### Method 2: Packaged Installation

1. Compress the entire `firefox-extension` directory into a ZIP file
2. Change the file extension from `.zip` to `.xpi`
3. Open the `.xpi` file in Firefox
4. Follow the prompts to complete installation

### 3. Verify Installation

1. Check if the JS Eyes icon appears in the Firefox toolbar
2. Click the icon to open the popup interface
3. Check the connection status (requires browserControlServer to be running)

## Pre-usage Setup

### Start browserControlServer

Run in the project root directory:

```bash
node server.js
```

Ensure the server is listening for WebSocket connections on port 8080.

### Configure Extension

1. Click the extension icon in the toolbar
2. Check the server address in the popup (default: ws://localhost:8080)
3. If modification is needed, change and save in the settings area
4. Confirm the connection status shows "Connected"

## Feature Testing

After installation, you can test the following features:

1. **Tab Synchronization**: Open/close tabs and observe statistics in the popup
2. **Connection Status**: Stop/start the server and observe connection status changes
3. **Data Sending**: Click the "Send Data" button to manually sync tab information
4. **Log Monitoring**: View activity logs in the popup to understand extension runtime status

## Troubleshooting

### 403 Forbidden Error

If you encounter a 403 Forbidden error, use the following solutions:

**Solution 1: Use Developer Mode (Recommended)**
- Follow "Method 1: Developer Mode" above for installation
- This method completely avoids 403 errors

**Solution 2: Modify Firefox Settings (Development Environment Only)**
1. Type in the address bar: `about:config`
2. Click "Accept the Risk and Continue"
3. Search for: `xpinstall.signatures.required`
4. Change the value to `false`
5. Restart Firefox and try installing the xpi file again

**Note**: Solution 2 reduces browser security and is only recommended for development environments.

### Extension Cannot Load

- Confirm all icon files have been generated and placed in the correct location
- Check if the `manifest.json` file syntax is correct
- View Firefox console error messages

### Cannot Connect to Server

- Confirm browserControlServer is running
- Check if port 8080 is occupied
- Confirm firewall settings allow local connections

### Permission Issues

- Check permission settings in Firefox's extension management page
- Ensure the extension has permissions to access tabs and cookies

## Development Debugging

### View Extension Logs

1. Visit `about:debugging`
2. Find the JS Eyes extension
3. Click "Inspect" to open developer tools
4. View console output

### Reload Extension

After modifying code:
1. On the `about:debugging` page
2. Find the extension and click "Reload"
3. Test new features

## Uninstall Extension

### Temporarily Installed Extension

1. Visit `about:debugging`
2. Find the extension and click "Remove"

### Officially Installed Extension

1. Visit `about:addons`
2. Find the JS Eyes extension
3. Click "Remove"

## Firefox Extension Official Signing

### Why is Official Signing Required?

Firefox by default only allows installation of extensions signed by Mozilla, which protects user security. Unsigned extensions will encounter 403 Forbidden errors.

### Methods to Obtain Official Signing

#### Method 1: AMO Release (Public Extensions)

1. **Register Developer Account**
   - Visit: https://addons.mozilla.org/
   - Click "Developer Hub" → "Register"
   - Log in with Firefox account

2. **Submit Extension for Review**
   - Log in to Developer Hub
   - Click "Submit a New Add-on"
   - Upload xpi file
   - Fill in extension details
   - Wait for review (usually 1-2 weeks)

3. **After Review Approval**
   - Extension automatically receives official signature
   - Users can install normally without 403 errors

#### Method 2: Self-Signing (Private Use)

1. **Install web-ext Tool**
   ```bash
   npm install -g web-ext
   ```

2. **Obtain API Key**
   - Visit: https://addons.mozilla.org/developers/addon/api/key/
   - Generate JWT issuer and secret

3. **Sign Extension**
   ```bash
   cd firefox-extension
   web-ext sign --api-key=your-api-key --api-secret=your-api-secret
   ```

4. **Use Signed xpi File**
   - Signed files can be installed normally
   - No need to modify Firefox settings

### Development Stage Recommendations

- **Development Testing**: Use developer mode (about:debugging)
- **Internal Use**: Use self-signing
- **Public Release**: Release through AMO review

---

After installation, the extension will establish a connection with browserControlServer, providing complete browser automation control functionality.
