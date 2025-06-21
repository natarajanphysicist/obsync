# Obsidian Cloud Sync

**Synchronize your Obsidian notes with Google Drive.**

Obsidian Cloud Sync is a plugin for Obsidian (https://obsidian.md) that allows you to keep your local vault synchronized with a dedicated folder in your Google Drive. This provides a way to back up your notes and access them across multiple devices where you have Google Drive access (though direct mobile sync via this plugin is focused on the Obsidian mobile app's capabilities with its backend).

## Features

*   **Two-Way Sync with Google Drive**: Keep your notes in sync between your local Obsidian vault and a dedicated Google Drive folder (`ObsidianVaultSync`).
*   **Authentication**: Securely authenticates with your Google Drive account using OAuth 2.0.
*   **Conflict Handling**: Basic conflict resolution. If a file has been changed both locally and on Google Drive since the last sync, the plugin will:
    *   Save your local conflicting changes to a new file (e.g., `your-note_local_conflict_TIMESTAMP.md`).
    *   Download the Google Drive version to the original file path (`your-note.md`).
    *   The local conflict file will then be uploaded as a new, separate note.
*   **Manual Sync Trigger**: A command to initiate synchronization whenever you choose.

## Prerequisites

Before you can use this plugin, you need to obtain Google Drive API credentials:

1.  **Go to the Google Cloud Console**: [https://console.cloud.google.com/](https://console.cloud.google.com/)
2.  **Create a new project** (or select an existing one).
3.  **Enable the Google Drive API**:
    *   In the navigation menu, go to "APIs & Services" > "Library".
    *   Search for "Google Drive API" and enable it for your project.
4.  **Create OAuth 2.0 Credentials**:
    *   Go to "APIs & Services" > "Credentials".
    *   Click "+ CREATE CREDENTIALS" and choose "OAuth client ID".
    *   If prompted, configure the "OAuth consent screen":
        *   **User Type**: External (unless you have a Google Workspace account and want to limit it internally).
        *   **App name**: Something like "Obsidian Cloud Sync" (this is what users will see on the consent screen).
        *   **User support email**: Your email.
        *   **Developer contact information**: Your email.
        *   Save and Continue through Scopes and Test Users (you can add your Google account as a test user during development/testing phase, and later publish the app).
    *   Back on the "Credentials" page, for "Application type", select "Desktop app".
    *   Give it a name (e.g., "Obsidian Sync Desktop Client").
    *   Click "CREATE".
5.  **Copy Your Credentials**:
    *   You will now see your **Client ID** and **Client Secret**. Copy these down. You will need them for the plugin settings.
    *   **Important Security Note**: Keep your Client Secret confidential. Do not share it publicly.

## Installation

**Important Note**: This plugin is written in TypeScript (`main.ts`). For Obsidian to use this plugin, the `main.ts` file **must be compiled into a JavaScript file (`main.js`)**. The `main.js` file is what Obsidian actually runs. If you are downloading the source code, you will likely need to perform this compilation step yourself.

**Steps (assuming you have `main.js`, `manifest.json`, and `styles.css`):**

1.  **Obtain Plugin Files**:
    *   From a release (e.g., on GitHub under `https://github.com/your-username/obsidian-cloud-sync/releases` - *replace with actual URL*), download `main.js`, `manifest.json`, and `styles.css`.
    *   If you have the source code, you must compile `main.ts` to get `main.js` (see "Compiling" section below).
2.  **Open Your Obsidian Vault's Plugins Folder**:
    *   In Obsidian, go to Settings (the gear icon).
    *   Navigate to "Community plugins".
    *   Ensure "Restricted mode" is **OFF**.
    *   Click the folder icon next to "Community plugins" to open your vault's plugins folder (typically `.obsidian/plugins/` within your vault).
3.  **Install the Plugin**:
    *   Create a new folder named `obsidian-cloud-sync` inside the plugins folder. (The ID `obsidian-cloud-sync` is specified in the `manifest.json`).
    *   Copy the `main.js`, `manifest.json`, and `styles.css` files into this new `obsidian-cloud-sync` folder.
4.  **Enable the Plugin**:
    *   In Obsidian, under "Community plugins", find "Cloud Sync" in the list and toggle it on.

**Compiling `main.ts` to `main.js` (for users downloading source or developers):**

1.  **Prerequisites**:
    *   Node.js and npm: Install from [nodejs.org](https://nodejs.org/).
    *   TypeScript: Install globally via npm: `npm install -g typescript`.
2.  **Compilation Steps**:
    *   Navigate to the plugin's root directory (where `main.ts` is located) in your terminal.
    *   It's highly recommended to have a `package.json` and `tsconfig.json` for managing dependencies (like `obsidian` API typings) and build configurations.
        *   If a `package.json` exists, run `npm install` to get any development dependencies.
        *   A typical `tsconfig.json` for an Obsidian plugin might look like:
            ```json
            {
              "compilerOptions": {
                "baseUrl": ".",
                "inlineSourceMap": true,
                "inlineSources": true,
                "module": "ESNext",
                "target": "ES2018",
                "allowJs": true,
                "noImplicitAny": true,
                "moduleResolution": "node",
                "importHelpers": true,
                "lib": [
                  "DOM",
                  "ES5",
                  "ES6",
                  "ES7",
                  "ES2018",
                  "ESNext"
                ]
              },
              "include": [
                "**/*.ts"
              ]
            }
            ```
    *   Run the TypeScript compiler: `tsc`
        *   If you don't have a `tsconfig.json`, you can try a direct command, but it's less robust: `tsc main.ts --target es2018 --moduleResolution node --lib esnext,dom`
    *   This command should generate a `main.js` file in the same directory. This is the file Obsidian uses.

## Configuration

1.  Once the plugin is enabled, go to the "Cloud Sync" tab in Obsidian's settings (usually at the bottom of the left-hand settings sidebar).
2.  **Cloud Provider**: Ensure "Google Drive" is selected.
3.  **Google Drive Client ID**: Paste the Client ID you obtained from the Google Cloud Console.
4.  **Google Drive Client Secret**: Paste the Client Secret you obtained.
5.  **Authenticate**:
    *   Open the Command Palette (Ctrl+P or Cmd+P on Windows/Linux, Cmd+P on macOS).
    *   Run the command: `Cloud Sync: Authenticate with Google Drive`.
    *   Your web browser will open to a Google authentication page. Log in with the Google account you want to use for syncing and grant the requested permissions.
    *   After granting permission, Google will redirect you. Copy the **authorization code** displayed.
    *   Return to Obsidian, open the Command Palette, and run: `Cloud Sync: Enter Google Drive Auth Code`.
    *   Paste the authorization code into the prompt and click OK.
    *   You should see a notice indicating successful authentication.

## Usage

*   **Manual Sync**: To synchronize your files, open the Command Palette and run the command: `Cloud Sync: Synchronize Now`.
    *   The plugin will compare your local files with the files in the `ObsidianVaultSync` folder in your Google Drive and perform necessary uploads, downloads, and deletions.
    *   Notifications will appear to indicate progress and completion. Check the developer console (Ctrl+Shift+I or Cmd+Option+I, then go to "Console") for more detailed logs.

## Known Issues & Limitations (Current Version)

*   **Initial Sync Can Be Slow**: The first sync, especially for large vaults, might take some time.
*   **Subdirectory Handling**: Current implementation is best suited for files directly in the vault root or simple first-level subdirectories. Deeply nested structures or numerous empty directories might not be handled with full robustness yet.
*   **No Real-time/Automatic Sync**: Synchronization is manual.
*   **Google Drive Only**: Only Google Drive is supported.
*   **Error Reporting**: Primarily through notices and console logs.
*   **No UI for Conflict Resolution Choice**: Conflicts are handled automatically by backing up local changes.

## Reporting Issues

If you find any bugs or have a feature request, please open an issue on the [GitHub repository issues page](https://github.com/your-username/obsidian-cloud-sync/issues) (*replace with actual URL*).

## Disclaimer

This plugin interacts with your personal data on Google Drive. Always ensure you have independent backups of your Obsidian vault. Use at your own risk. The developer is not responsible for any data loss.
```
