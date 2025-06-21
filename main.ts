import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

// Note: The duplicate import of App, Plugin, PluginSettingTab, Setting might exist due to prior edits.
// It's good practice to clean this up, but for now, just adding TFile.
// The TypeScript compiler will likely handle the duplicate imports gracefully.

interface CloudSyncSettings {
	cloudProvider: string;
	googleDriveClientId: string;
	googleDriveClientSecret: string;
	googleDriveAccessToken?: string;
	googleDriveRefreshToken?: string;
	googleDriveTokenExpiry?: number;
	oneDriveClientId: string;
	oneDriveClientSecret: string;
	// Add fields for OneDrive tokens later
	googleDriveStartPageToken?: string; // For GDrive Changes API
	googleDriveAppFolderId?: string; // To store the ID of the dedicated app folder
	fileMap?: Record<string, FileSyncState>; // Maps local relative path to sync state information
}

interface FileSyncState {
	remoteId: string;       // Google Drive File ID
	remoteMtime?: string;  // ISO string (modifiedTime from Google Drive)
	remoteMd5?: string;    // md5Checksum from Google Drive
	localMtimeEpoch?: number; // Local file modification time (this.app.vault.adapter.stat(path).mtime)
	// lastSyncDirection?: 'up' | 'down'; // Could be useful for conflict resolution
	// lastSyncTimestamp?: number;
}

const DEFAULT_SETTINGS: CloudSyncSettings = {
	cloudProvider: 'google-drive',
	googleDriveClientId: '',
	googleDriveClientSecret: '',
	oneDriveClientId: '',
	oneDriveClientSecret: '',
	fileMap: {}, // Initialize as empty object
	// googleDriveAccessToken, googleDriveRefreshToken, googleDriveTokenExpiry, googleDriveStartPageToken, googleDriveAppFolderId will be undefined initially
}

export default class CloudSyncPlugin extends Plugin {
	settings: CloudSyncSettings;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new CloudSyncSettingTab(this.app, this));

		// Add a command to initiate Google Drive authentication
		this.addCommand({
			id: 'google-drive-authenticate',
			name: 'Authenticate with Google Drive',
			callback: () => {
				this.authenticateWithGoogleDrive();
			}
		});

		this.addCommand({
			id: 'test-google-drive-token',
			name: 'Test Google Drive Token',
			callback: async () => {
				const token = await this.getValidGoogleDriveToken();
				if (token) {
					new Notice('Google Drive token is valid.');
					// You could add a simple API call here to truly test it, e.g., fetch user info
					try {
						const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
							headers: { Authorization: `Bearer ${token}` }
						});
						if (response.ok) {
							const userInfo = await response.json();
							new Notice(`Authenticated as: ${userInfo.name || userInfo.email}`);
						} else {
							new Notice('Token seems valid, but user info request failed.');
						}
					} catch (e) {
						new Notice('Error fetching user info.');
						console.error(e);
					}
				} else {
					new Notice('Google Drive token is invalid or missing. Please authenticate.');
				}
			}
		});

		// Test commands for GDrive operations (temporary)
		this.addCommand({
			id: 'gdrive-test-list-files',
			name: 'GDrive: Test List Files in App Folder',
			callback: async () => {
				const files = await this.listGoogleDriveFiles();
				if (files.length > 0) {
					new Notice(`Listed ${files.length} files/folders. Check console for details.`);
					console.log("GDrive Files:", files);
				} else {
					new Notice('No files found or error during listing.');
				}
			}
		});

		this.addCommand({
			id: 'gdrive-test-upload-file',
			name: 'GDrive: Test Upload Sample File',
			callback: async () => {
				const appFolderId = await this.findOrCreateAppFolder();
				if (!appFolderId) return;

				const fileName = `test-upload-${Date.now()}.md`;
				const fileContent = new TextEncoder().encode(`# Test File\n\nThis is a test file uploaded at ${new Date().toISOString()}`);
				const mimeType = 'text/markdown';

				const fileId = await this.uploadGoogleDriveFile(fileName, fileContent, mimeType, appFolderId);
				if (fileId) {
					new Notice(`Uploaded test file. ID: ${fileId}`);
					// Try to download it back for verification
					const downloadedContent = await this.downloadGoogleDriveFile(fileId, fileName);
					if (downloadedContent) {
						const textContent = new TextDecoder().decode(downloadedContent);
						console.log("Downloaded content:", textContent);
						if (textContent === new TextDecoder().decode(fileContent)) {
							new Notice("Test upload and download successful!");
						} else {
							new Notice("Test upload successful, but download verification failed.");
						}
					}
				}
			}
		});

		this.registerVaultEvents();

		this.addCommand({
			id: 'gdrive-test-fetch-changes',
			name: 'GDrive: Test Fetch Changes',
			callback: async () => {
				let pageToken = this.settings.googleDriveStartPageToken;
				if (!pageToken) {
					new Notice('No GDrive startPageToken found, fetching a new one...');
					pageToken = await this.getGoogleDriveStartPageToken();
					if (!pageToken) {
						new Notice('Failed to get GDrive startPageToken. Aborting test.');
						return;
					}
				}

				new Notice(`Attempting to fetch changes with token: ${pageToken.substring(0,20)}...`);
				const changesResult = await this.fetchGoogleDriveChanges(pageToken);

				if (changesResult) {
					new Notice(`Fetched ${changesResult.changes.length} relevant changes. Next token starts with ${changesResult.newStartPageToken?.substring(0,20)}. Check console.`);
					console.log("GDrive Changes Result:", changesResult);
					// Update the token in settings for the next poll
					if (changesResult.newStartPageToken) {
						this.settings.googleDriveStartPageToken = changesResult.newStartPageToken;
						await this.saveSettings();
						new Notice("Saved new start page token for next poll.");
					} else if (changesResult.nextPageToken) {
						// If there are many changes, nextPageToken is used to get the rest of the current batch.
						// newStartPageToken is the one to use for the *next time* you poll after processing this batch.
						// For simplicity in this test, we'll just save newStartPageToken if available,
						// otherwise, we assume this was the last page of current changes and the newStartPageToken
						// was already saved by fetchGoogleDriveChanges itself.
						console.log("Using newStartPageToken for the next poll from within fetchGoogleDriveChanges.");
					}


				} else {
					new Notice('Failed to fetch GDrive changes. Check console.');
				}
			}
		});

		this.addCommand({
			id: 'cloud-sync-now',
			name: 'Cloud Sync: Synchronize Now',
			callback: async () => {
				await this.syncNow();
			}
		});
	}

	async syncNow() {
		new Notice('Starting synchronization...');
		if (this.settings.cloudProvider !== 'google-drive') {
			new Notice('Only Google Drive is currently supported.');
			return;
		}

		// 1. Ensure Authentication and App Folder
		const token = await this.getValidGoogleDriveToken();
		if (!token) {
			new Notice('Google Drive authentication required. Please authenticate and try again.');
			return;
		}

		const appFolderId = await this.findOrCreateAppFolder();
		if (!appFolderId) {
			new Notice('Could not find or create the Google Drive app folder. Sync aborted.');
			return;
		}
		// Ensure appFolderId is saved in settings if it wasn't already
		if (!this.settings.googleDriveAppFolderId) {
			this.settings.googleDriveAppFolderId = appFolderId;
			await this.saveSettings();
		}


		// Initialize fileMap if it's not already there
		if (!this.settings.fileMap) {
			this.settings.fileMap = {};
		}

		new Notice('Fetching local and remote file states...');

		// 2. Get Local State
		const localFiles: Map<string, { path: string, mtime: number, content?: ArrayBuffer /* for uploads */ }> = new Map();
		const files = this.app.vault.getMarkdownFiles(); // Or getFiles() for all file types
		// TODO: Add logic to get all files, not just markdown, and handle binary files appropriately.
		// TODO: Implement proper path handling to ensure they are relative to the vault root and normalized.

		for (const file of files) {
			// Ignore files in .obsidian folder or other configured ignore paths (future feature)
			if (file.path.startsWith('.obsidian/')) {
				continue;
			}
			try {
				const stat = await this.app.vault.adapter.stat(file.path);
				if (stat) {
					localFiles.set(file.path, { path: file.path, mtime: stat.mtime });
				}
			} catch (e) {
				console.warn(`Could not stat local file ${file.path}: ${e.message}`);
			}
		}
		console.log(`Found ${localFiles.size} local files to consider.`);
		new Notice(`Found ${localFiles.size} local files.`);

		// 3. Fetch Remote State/Changes (Simplified: Full scan for now)
		// More advanced: Use Changes API (this.fetchGoogleDriveChanges)
		// For this initial syncNow, we'll do a full list to build/update the fileMap.

		const remoteDriveFiles = await this.listGoogleDriveFiles(appFolderId);
		const remoteFilesMap: Map<string, any> = new Map(); // Map by remote file name (path)
		for (const driveFile of remoteDriveFiles) {
			if (driveFile.mimeType === 'application/vnd.google-apps.folder') {
				// Basic handling for folders: log them, actual sync of empty folders or folder structure
				// would require more logic (e.g. creating local folders if they don't exist on download)
				console.log(`Remote folder found: ${driveFile.name} (ID: ${driveFile.id})`);
				// Potentially, we could map remote folder structure to local structure here.
				continue;
			}
			remoteFilesMap.set(driveFile.name, driveFile); // Assuming driveFile.name is the path relative to app folder
		}
		console.log(`Found ${remoteFilesMap.size} remote files in app folder.`);
		new Notice(`Found ${remoteFilesMap.size} remote files.`);

		// 4. Compare and Reconcile (Initial simplified version)
		// This is where the core logic will go.
		// For now, just logging local and remote files.

		new Notice('Comparison and reconciliation logic not yet fully implemented.');
		console.log("Local Files Map:", localFiles);
		console.log("Remote Files Map (from GDrive):", remoteFilesMap);

		// TODO: Implement the detailed comparison logic outlined in the plan.

		// --- Iterate local files: Upload new or updated files ---
		for (const [path, localFileStat] of localFiles.entries()) {
			const existingMapping = this.settings.fileMap![path];
			let operation: 'upload_new' | 'upload_update' | 'skip' = 'skip';
			let reason = '';

			if (!existingMapping) {
				operation = 'upload_new';
				reason = 'New local file.';
			} else {
				// Compare local file's current mtime with the mtime we last knew about for this local file
				if (!existingMapping.localMtimeEpoch || localFileStat.mtime > existingMapping.localMtimeEpoch) { // Local file has changed since our record of it
					const lastKnownRemoteMtimeEpoch = existingMapping.remoteMtime ? Date.parse(existingMapping.remoteMtime) : 0;
					const currentRemoteDriveFile = remoteFilesMap.get(path);
					const currentRemoteMtimeEpoch = currentRemoteDriveFile ? Date.parse(currentRemoteDriveFile.modifiedTime) : 0;

					if (currentRemoteDriveFile && currentRemoteMtimeEpoch > lastKnownRemoteMtimeEpoch) {
						// Both local and remote have changed since last sync point. This is a conflict.
						operation = 'skip'; // Will be handled by download logic, potentially creating a conflicted copy then.
						reason = `CONFLICT: Local changed (our mtime ${new Date(existingMapping.localMtimeEpoch || 0).toISOString()} -> current ${new Date(localFileStat.mtime).toISOString()}) AND Remote changed (our mtime ${existingMapping.remoteMtime} -> current ${currentRemoteDriveFile.modifiedTime}).`;
						console.warn(`Conflict for ${path}: ${reason}. Local will be backed up before remote overwrite.`);

						// Backup local file before allowing remote to overwrite
						try {
							const localContent = await this.app.vault.adapter.readBinary(path);
							const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
							const conflictPath = `${path.substring(0, path.lastIndexOf('.'))}_local_conflict_${timestamp}${path.substring(path.lastIndexOf('.'))}`;
							await this.app.vault.createBinary(conflictPath, localContent);
							new Notice(`Conflict detected for ${path}. Local version saved to ${conflictPath}. Remote version will be downloaded.`);
							// Remove from localFiles map so download logic treats original path as needing update from remote.
                            // And update filemap for the conflict file as a new upload.
                            const conflictFileStat = await this.app.vault.adapter.stat(conflictPath);
                            if (conflictFileStat) {
                                localFiles.set(conflictPath, {path: conflictPath, mtime: conflictFileStat.mtime}); // Add to local files to be processed for upload
                                // No entry in fileMap for conflictPath yet, so it will be treated as 'upload_new'
                            }

						} catch (e) {
							new Notice(`Error creating local backup for conflicted file ${path}: ${e.message}`);
							console.error(`Error creating local backup for ${path}:`, e);
							reason += " Backup failed. Upload skipped.";
						}
						// By skipping upload, we let the download logic handle overwriting the original path with the remote version.
                        // The local changes are preserved in the _local_conflict_... file.
					} else if (localFileStat.mtime > currentRemoteMtimeEpoch ) {
						// Local changed, remote hasn't (or local is clearly newer than current remote)
						operation = 'upload_update';
						reason = 'Local file is newer than remote, and remote has not changed independently.';
					} else {
                        // Local changed, but remote is newer or same. Let download logic handle.
                        operation = 'skip';
                        reason = `Local changed, but remote is same or newer. Local: ${new Date(localFileStat.mtime).toISOString()}, Remote: ${currentRemoteDriveFile?.modifiedTime}. Skipping upload.`;
                    }
				} else {
					operation = 'skip';
					reason = 'Local file unchanged since last known state.';
				}
			}

			console.log(`File: ${path}, Operation: ${operation}, Reason: ${reason}`);

			if (operation === 'upload_new' || operation === 'upload_update') {
				try {
					const fileContent = await this.app.vault.adapter.readBinary(path);
					// TODO: Determine actual MIME type. For now, assume markdown or plain text for .md
					const mimeType = path.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';

					const existingRemoteFileId = operation === 'upload_update' ? existingMapping.remoteId : undefined;

					new Notice(`Uploading ${path} (${operation})...`);
					const remoteId = await this.uploadGoogleDriveFile(path, fileContent, mimeType, appFolderId, existingRemoteFileId);

					if (remoteId) {
						// Fetch the latest metadata for the uploaded file to get the accurate remoteMtime
						const updatedRemoteFile = remoteFilesMap.get(path) || // If it was already listed
							(await this.listGoogleDriveFiles(appFolderId)).find(f => f.id === remoteId); // Or fetch specifically

						this.settings.fileMap![path] = {
							remoteId: remoteId,
							localMtimeEpoch: localFileStat.mtime,
							remoteMtime: updatedRemoteFile?.modifiedTime, // Store the actual remote mtime
							remoteMd5: updatedRemoteFile?.md5Checksum,
						};
						new Notice(`Successfully uploaded ${path}.`);
						if (updatedRemoteFile) remoteFilesMap.set(path, updatedRemoteFile); // Update our view of remote state
					} else {
						new Notice(`Failed to upload ${path}.`);
					}
				} catch (e) {
					new Notice(`Error processing local file ${path} for upload: ${e.message}`);
					console.error(`Error processing local file ${path} for upload:`, e);
				}
			}
		}
		await this.saveSettings(); // Save fileMap changes after uploads

		// --- Iterate remote files: Download new or updated files ---
		for (const [path, remoteDriveFile] of remoteFilesMap.entries()) {
			// Path here is remoteDriveFile.name, assumed to be the relative path in the vault
			const localFileStat = localFiles.get(path);
			const existingMapping = this.settings.fileMap![path];
			let operation: 'download_new' | 'download_update' | 'skip' = 'skip';
			let reason = '';

			const remoteMtimeEpoch = Date.parse(remoteDriveFile.modifiedTime);

			if (!localFileStat) {
				// File exists remotely, but not locally
				operation = 'download_new';
				reason = 'New remote file.';
			} else {
				// File exists in both places. Check mtimes.
				// existingMapping should exist if localFileStat exists and upload phase ran.
				// If existingMapping.remoteMtime is older than remoteDriveFile.modifiedTime, remote has updated.
				const lastKnownRemoteMtimeEpoch = existingMapping?.remoteMtime ? Date.parse(existingMapping.remoteMtime) : 0;

				if (remoteMtimeEpoch > lastKnownRemoteMtimeEpoch) {
					// Remote file is definitely newer than our last record of it.
					// Now, compare with local file's actual mtime for conflict.
					if (remoteMtimeEpoch > localFileStat.mtime) {
						operation = 'download_update';
						reason = 'Remote file is newer than local file.';
					} else if (remoteMtimeEpoch < localFileStat.mtime) {
						// Local is newer. This should have been handled by upload phase if local changed since last sync.
						// If local hasn't changed since last sync, but remote is older than local, it's odd.
						// This implies remote somehow reverted. For now, we trust local if it's newer.
						operation = 'skip';
						reason = `Local file (${new Date(localFileStat.mtime).toISOString()}) is newer than this remote version (${remoteDriveFile.modifiedTime}). Upload should have handled or will handle.`;
						console.warn(`Skipping download for ${path}: ${reason}`);
					} else {
						// Timestamps match. Assume synced or content is same.
						operation = 'skip';
						reason = 'Remote and local times suggest no remote change or local is same/newer.';
					}
				} else {
					operation = 'skip';
					reason = 'Remote file unchanged or older than last known state.';
				}
			}

			console.log(`Remote File: ${path}, Operation: ${operation}, Reason: ${reason}`);

			if (operation === 'download_new' || operation === 'download_update') {
				new Notice(`Downloading ${path} (${operation})...`);
				try {
					const fileContent = await this.downloadGoogleDriveFile(remoteDriveFile.id, remoteDriveFile.name);
					if (fileContent) {
						if (operation === 'download_new') {
							// Ensure parent directories exist locally (Obsidian might do this, but good to be aware)
							// For root files, path is fine. For nested, this.app.vault.createFolder might be needed.
							// For now, assuming flat structure or Obsidian handles parent folder creation on createBinary.
							await this.app.vault.createBinary(path, fileContent);
						} else { // download_update
							const localTFile = this.app.vault.getAbstractFileByPath(path);
							if (localTFile && localTFile instanceof TFile) {
								await this.app.vault.modifyBinary(localTFile, fileContent);
							} else {
								// Should not happen if localFileStat existed.
								console.error(`Tried to update non-existent/non-file local path: ${path}. Creating instead.`);
								await this.app.vault.createBinary(path, fileContent);
							}
						}

						// Update fileMap with the new state
						const updatedLocalStat = await this.app.vault.adapter.stat(path);
						this.settings.fileMap![path] = {
							remoteId: remoteDriveFile.id,
							remoteMtime: remoteDriveFile.modifiedTime,
							remoteMd5: remoteDriveFile.md5Checksum,
							localMtimeEpoch: updatedLocalStat ? updatedLocalStat.mtime : Date.now(), // Use actual new mtime
						};
						new Notice(`Successfully downloaded and saved ${path}.`);
					} else {
						new Notice(`Failed to download content for ${path}.`);
					}
				} catch (e) {
					new Notice(`Error processing remote file ${path} for download: ${e.message}`);
					console.error(`Error processing remote file ${path} for download:`, e);
				}
			}
		}
		await this.saveSettings(); // Save fileMap changes after downloads

		// --- Handle Deletions ---

		// Part 1: Local Deletions (files in fileMap but not in local vault anymore)
		for (const pathInMap in this.settings.fileMap) {
			if (!localFiles.has(pathInMap)) {
				const mapping = this.settings.fileMap[pathInMap];
				new Notice(`Local file ${pathInMap} deleted. Deleting from Google Drive...`);
				try {
					const success = await this.deleteGoogleDriveFile(mapping.remoteId);
					if (success) {
						new Notice(`Successfully deleted ${pathInMap} from Google Drive.`);
						delete this.settings.fileMap[pathInMap];
					} else {
						new Notice(`Failed to delete ${pathInMap} from Google Drive.`);
						// Decide if we keep it in fileMap or not. For now, keep, maybe it'll sync later.
					}
				} catch (e) {
					new Notice(`Error deleting remote file ${pathInMap}: ${e.message}`);
					console.error(`Error deleting remote file ${pathInMap}:`, e);
				}
			}
		}
		await this.saveSettings();


		// Part 2: Remote Deletions (files in fileMap but not on remote anymore - based on full scan)
		// This logic assumes `remoteFilesMap` is a complete representation of the remote app folder.
		// If a file is in our `fileMap` but NOT in `remoteFilesMap`, it means it was deleted on the remote.
		for (const pathInMap in this.settings.fileMap) {
			if (!remoteFilesMap.has(pathInMap)) {
				// Check if it was deleted locally already (covered by Part 1)
				// If it's still in fileMap here, means Part 1 didn't remove it,
				// implies local file might still exist or Part 1 failed to delete remote.
				// But the primary check is: if remoteFilesMap doesn't have it, it's gone from remote.

				const localFileExists = this.app.vault.getAbstractFileByPath(pathInMap);
				if (localFileExists) { // Only delete locally if it actually exists
					new Notice(`Remote file ${pathInMap} seems deleted. Deleting locally...`);
					try {
						await this.app.vault.delete(localFileExists);
						new Notice(`Successfully deleted local file ${pathInMap}.`);
					} catch (e) {
						new Notice(`Error deleting local file ${pathInMap}: ${e.message}`);
						console.error(`Error deleting local file ${pathInMap}:`, e);
						// If local delete fails, we probably shouldn't remove from fileMap.
						continue; // Skip deleting from fileMap
					}
				}
				// Whether local existed or not, if remote is gone, remove from map.
				delete this.settings.fileMap[pathInMap];
			}
		}
		// TODO: Remote deletions: If file from GDrive Changes API is `removed:true` and in `fileMap`, delete local. Remove from `fileMap`.
		//       (The current full scan `remoteFilesMap` won't show deleted files unless we compare it to a previous state of `fileMap`)


		new Notice('Synchronization attempt partially implemented (uploads). Check console.');
	}


	onunload() {
		// Event listeners registered with this.registerEvent are automatically cleaned up by Obsidian
		console.log("Unloading CloudSyncPlugin");
	}

	registerVaultEvents() {
		console.log("Registering vault events for Cloud Sync");

		// Using this.registerEvent ensures Obsidian manages cleanup on unload
		this.registerEvent(this.app.vault.on('create', (file) => {
			// TAbstractFile can be TFile or TFolder. We only care about files for content sync.
			// Folders will be handled by ensuring parent folders exist during file uploads.
			if (file instanceof TFile) {
				console.log('Cloud Sync: File created:', file.path);
				// Future: Add to a sync queue or trigger sync for this file
			}
		}));

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile) {
				console.log('Cloud Sync: File modified:', file.path);
				// Future: Add to a sync queue or trigger sync for this file
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			// Can be TFile or TFolder
			console.log('Cloud Sync: File or folder deleted:', file.path);
			// Future: Add to a sync queue or trigger sync for this deletion
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			// Can be TFile or TFolder
			console.log('Cloud Sync: File or folder renamed:', oldPath, '->', file.path);
			// Future: Handle as a delete of oldPath and create/update of file.path on the remote
		}));
	}

	async authenticateWithGoogleDrive() {
		if (!this.settings.googleDriveClientId || !this.settings.googleDriveClientSecret) {
			new Notice('Please configure Google Drive Client ID and Secret in settings.');
			return;
		}

		const redirectUri = 'obsidian://oauth2callback'; // Or a custom URI scheme if possible
		const scope = 'https://www.googleapis.com/auth/drive.file';
		const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${this.settings.googleDriveClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

		// Open the authentication URL in the system browser
		window.open(authUrl);

		// Need to handle the callback, which is tricky in Obsidian's environment.
		// Obsidian doesn't have a straightforward way to listen for custom URI scheme callbacks.
		// One common approach is to have the user manually copy the auth code.
		// Or, set up a local server to catch the redirect, but that adds complexity.

		new Notice('Please copy the authorization code from your browser and paste it using the "Enter Google Drive Auth Code" command.');

		// We'll add another command to input this code.
		if (!this.commands.find(cmd => cmd.id === 'google-drive-enter-auth-code')) {
			this.addCommand({
				id: 'google-drive-enter-auth-code',
				name: 'Enter Google Drive Auth Code',
				callback: async () => {
					// Simple prompt for now. A modal would be better.
					const authCode = prompt('Enter Google Drive Authorization Code:');
					if (authCode) {
						await this.exchangeAuthCodeForToken(authCode.trim());
					}
				}
			});
		}
	}

	async exchangeAuthCodeForToken(authCode: string) {
		const tokenUrl = 'https://oauth2.googleapis.com/token';
		const redirectUri = 'obsidian://oauth2callback'; // Must match the one used in authUrl

		try {
			const response = await fetch(tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					code: authCode,
					client_id: this.settings.googleDriveClientId,
					client_secret: this.settings.googleDriveClientSecret,
					redirect_uri: redirectUri,
					grant_type: 'authorization_code',
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				new Notice(`Error exchanging auth code: ${errorData.error_description || response.statusText}`);
				console.error('Token exchange error:', errorData);
				return;
			}

			const tokenData = await response.json();
			this.settings.googleDriveAccessToken = tokenData.access_token;
			this.settings.googleDriveRefreshToken = tokenData.refresh_token; // Important for long-term access
			this.settings.googleDriveTokenExpiry = Date.now() + (tokenData.expires_in * 1000);
			await this.saveSettings();
			new Notice('Google Drive authentication successful!');
		} catch (error) {
			new Notice('Failed to exchange authorization code. See console for details.');
			console.error('Error during token exchange:', error);
		}
	}

	async refreshGoogleDriveAccessToken(): Promise<boolean> {
		if (!this.settings.googleDriveRefreshToken) {
			new Notice('Not authenticated with Google Drive or missing refresh token.');
			return false;
		}

		const tokenUrl = 'https://oauth2.googleapis.com/token';
		try {
			const response = await fetch(tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: this.settings.googleDriveClientId,
					client_secret: this.settings.googleDriveClientSecret,
					refresh_token: this.settings.googleDriveRefreshToken,
					grant_type: 'refresh_token',
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				new Notice(`Error refreshing Google Drive token: ${errorData.error_description || response.statusText}`);
				console.error('Token refresh error:', errorData);
				// May need to prompt for re-authentication here
				this.settings.googleDriveAccessToken = undefined;
				this.settings.googleDriveRefreshToken = undefined;
				this.settings.googleDriveTokenExpiry = undefined;
				await this.saveSettings();
				return false;
			}

			const tokenData = await response.json();
			this.settings.googleDriveAccessToken = tokenData.access_token;
			// A new refresh token might be issued, but often is not with Google.
			// If tokenData.refresh_token exists, update it.
			if (tokenData.refresh_token) {
				this.settings.googleDriveRefreshToken = tokenData.refresh_token;
			}
			this.settings.googleDriveTokenExpiry = Date.now() + (tokenData.expires_in * 1000);
			await this.saveSettings();
			new Notice('Google Drive token refreshed successfully.');
			return true;
		} catch (error) {
			new Notice('Failed to refresh Google Drive token. See console for details.');
			console.error('Error during token refresh:', error);
			return false;
		}
	}

	async getValidGoogleDriveToken(): Promise<string | null> {
		if (!this.settings.googleDriveAccessToken || !this.settings.googleDriveTokenExpiry) {
			new Notice('Not authenticated with Google Drive.');
			return null;
		}

		if (Date.now() >= this.settings.googleDriveTokenExpiry - 60 * 1000) { // Refresh if within 1 minute of expiry
			new Notice('Google Drive token expired or nearing expiry, refreshing...');
			const success = await this.refreshGoogleDriveAccessToken();
			if (!success) {
				new Notice('Failed to refresh Google Drive token. Please re-authenticate.');
				return null;
			}
		}
		return this.settings.googleDriveAccessToken;
	}

	// --- Google Drive API Interaction Placeholder Functions ---

	async findOrCreateAppFolder(): Promise<string | null> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) {
			new Notice('Authentication required for Google Drive.');
			return null;
		}
		// If already found and stored, return it
		if (this.settings.googleDriveAppFolderId) {
			return this.settings.googleDriveAppFolderId;
		}

		const appFolderName = 'ObsidianVaultSync';
		try {
			// Check if folder exists
			let response = await fetch(`https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder' and name='${appFolderName}' and trashed=false`, {
				headers: { 'Authorization': `Bearer ${token}` }
			});
			if (!response.ok) {
				throw new Error(`Failed to search for folder: ${response.statusText}`);
			}
			let data = await response.json();
			if (data.files && data.files.length > 0) {
				const folderId = data.files[0].id;
				new Notice(`Found app folder: ${appFolderName} (ID: ${folderId})`);
				this.settings.googleDriveAppFolderId = folderId;
				await this.saveSettings();
				return folderId;
			}

			// Create folder if it doesn't exist
			new Notice(`App folder "${appFolderName}" not found, creating it...`);
			response = await fetch('https://www.googleapis.com/drive/v3/files', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					name: appFolderName,
					mimeType: 'application/vnd.google-apps.folder'
				})
			});
			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(`Failed to create folder: ${response.statusText} - ${errorBody}`);
			}
			data = await response.json();
			const folderId = data.id;
			new Notice(`Created app folder: ${appFolderName} (ID: ${folderId})`);
			this.settings.googleDriveAppFolderId = folderId;
			await this.saveSettings();
			return folderId;
		} catch (error) {
			new Notice(`Error finding or creating app folder: ${error.message}`);
			console.error('findOrCreateAppFolder error:', error);
			return null;
		}
	}

	async listGoogleDriveFiles(folderId?: string): Promise<any[]> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) return [];

		const targetFolderId = folderId || await this.findOrCreateAppFolder();
		if (!targetFolderId) {
			new Notice('Could not determine target folder for listing files.');
			return [];
		}

		new Notice(`Listing files in Google Drive folder ID: ${targetFolderId}...`);
		try {
			// The query `trashed=false` ensures we only get non-deleted files.
			// `fields` query parameter is used to specify which file properties we want.
			// `parents in '${targetFolderId}'` lists files directly within that folder.
			const query = encodeURIComponent(`'${targetFolderId}' in parents and trashed=false`);
			const fields = encodeURIComponent("nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum)");
			let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=100`; // pageSize can be up to 1000

			let allFiles: any[] = [];
			let pageToken: string | undefined = undefined;

			do {
				const currentUrl = pageToken ? `${url}&pageToken=${pageToken}` : url;
				const response = await fetch(currentUrl, {
					headers: { 'Authorization': `Bearer ${token}` }
				});

				if (!response.ok) {
					const errorData = await response.json();
					throw new Error(`Failed to list files: ${errorData.error.message || response.statusText}`);
				}

				const data = await response.json();
				if (data.files) {
					allFiles = allFiles.concat(data.files);
				}
				pageToken = data.nextPageToken;
			} while (pageToken);

			new Notice(`Found ${allFiles.length} files/folders in the app folder.`);
			console.log('Files in app folder:', allFiles);
			return allFiles;

		} catch (error) {
			new Notice(`Error listing Google Drive files: ${error.message}`);
			console.error('listGoogleDriveFiles error:', error);
			return [];
		}
	}

	async downloadGoogleDriveFile(fileId: string, fileName: string): Promise<ArrayBuffer | null> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) return null;

		new Notice(`Downloading ${fileName} (ID: ${fileId}) from Google Drive...`);
		try {
			const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
				headers: { 'Authorization': `Bearer ${token}` }
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({})); // Try to parse error, but don't fail if not JSON
				throw new Error(`Failed to download file: ${errorData?.error?.message || response.statusText}`);
			}

			const fileContent = await response.arrayBuffer();
			new Notice(`Successfully downloaded ${fileName}.`);
			return fileContent;

		} catch (error) {
			new Notice(`Error downloading file ${fileName}: ${error.message}`);
			console.error(`downloadGoogleDriveFile error for ${fileId}:`, error);
			return null;
		}
	}

	async uploadGoogleDriveFile(
		fileName: string, // Relative path in vault, used as file name in Drive
		fileContent: ArrayBuffer,
		mimeType: string,
		parentFolderIdToEnsure?: string, // ID of the immediate parent folder in Drive
		existingFileId?: string // If updating an existing file
	): Promise<string | null> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) return null;

		const effectiveParentFolderId = parentFolderIdToEnsure || await this.findOrCreateAppFolder();
		if (!effectiveParentFolderId) {
			new Notice('Could not determine target folder for upload.');
			return null;
		}

		new Notice(`Uploading ${fileName} to Google Drive folder ID: ${effectiveParentFolderId}...`);

		const metadata: { name: string; mimeType: string; parents?: string[] } = {
			name: fileName, // Or extract actual file name from path
			mimeType: mimeType,
		};

		// If not updating an existing file, specify the parent folder for creation.
		if (!existingFileId) {
			metadata.parents = [effectiveParentFolderId];
		}

		const boundary = '-------314159265358979323846'; // Some random boundary
		const delimiter = `\r\n--${boundary}\r\n`;
		const close_delim = `\r\n--${boundary}--`;

		let requestBody =
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			JSON.stringify(metadata) +
			delimiter +
			'Content-Type: ' + mimeType + '\r\n' +
			// 'Content-Transfer-Encoding: base64\r\n' + // Use if body is base64 string
			'\r\n';
			// Directly append ArrayBuffer bytes after this.
			// However, fetch body doesn't directly support concatenating string and ArrayBuffer.
			// We need to create a Blob.

		const blob = new Blob([
			new TextEncoder().encode(requestBody), // Encode the string part to Uint8Array
			fileContent, // Append the ArrayBuffer directly
			new TextEncoder().encode(close_delim) // Encode the closing delimiter
		]);

		const uploadUrl = existingFileId
			? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart` // Update
			: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'; // Create

		try {
			const response = await fetch(uploadUrl, {
				method: existingFileId ? 'PATCH' : 'POST', // PATCH for update, POST for create
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': `multipart/related; boundary=${boundary}`
					// 'Content-Length' will be set automatically by the browser/fetch for Blob
				},
				body: blob
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				throw new Error(`Failed to upload file: ${errorData?.error?.message || response.statusText}`);
			}

			const responseData = await response.json();
			new Notice(`Successfully uploaded ${fileName} (ID: ${responseData.id}).`);
			return responseData.id; // Return the file ID (new or existing)

		} catch (error) {
			new Notice(`Error uploading file ${fileName}: ${error.message}`);
			console.error(`uploadGoogleDriveFile error for ${fileName}:`, error);
			return null;
		}
	}

	// --- End Google Drive API Interaction Placeholder Functions ---

	async deleteGoogleDriveFile(fileId: string): Promise<boolean> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) {
			new Notice('Authentication required to delete Google Drive file.');
			return false;
		}

		new Notice(`Deleting Google Drive file ID: ${fileId}...`);
		try {
			const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
				method: 'DELETE',
				headers: {
					'Authorization': `Bearer ${token}`
				}
			});

			if (response.ok) { // Status 204 No Content is success for DELETE
				new Notice(`Successfully deleted Google Drive file ID: ${fileId}.`);
				return true;
			} else {
				const errorData = await response.json().catch(() => ({}));
				new Notice(`Failed to delete Google Drive file ID ${fileId}: ${errorData?.error?.message || response.statusText}`);
				console.error(`Failed to delete GDrive file ${fileId}:`, errorData);
				return false;
			}
		} catch (error) {
			new Notice(`Error deleting Google Drive file ID ${fileId}: ${error.message}`);
			console.error(`Error deleting GDrive file ${fileId}:`, error);
			return false;
		}
	}

	async getGoogleDriveStartPageToken(): Promise<string | null> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) return null;

		try {
			const response = await fetch('https://www.googleapis.com/drive/v3/changes/startPageToken', {
				headers: { 'Authorization': `Bearer ${token}` }
			});
			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				throw new Error(`Failed to get startPageToken: ${errorData?.error?.message || response.statusText}`);
			}
			const data = await response.json();
			this.settings.googleDriveStartPageToken = data.startPageToken;
			await this.saveSettings();
			new Notice('Google Drive startPageToken obtained.');
			return data.startPageToken;
		} catch (error) {
			new Notice(`Error getting startPageToken: ${error.message}`);
			console.error('getGoogleDriveStartPageToken error:', error);
			return null;
		}
	}

	async fetchGoogleDriveChanges(pageToken: string): Promise<{ changes: any[], nextPageToken: string, newStartPageToken: string } | null> {
		const token = await this.getValidGoogleDriveToken();
		if (!token) return null;

		// Ensure we are watching changes within our specific app folder.
		// This requires knowing the appFolderId.
		// The `spaces` parameter can be 'drive' for all user-visible files, or 'appDataFolder' for hidden app data.
		// We use 'drive' since our app folder is user-visible.
		// Add `restrictToAppFolder: true` if using a special Drive scope that limits to app-created files only.
		// For `drive.file` scope, we need to filter changes by parent folder if possible, or process all changes and filter client-side.
		// The Changes API itself does not directly support filtering by parent folder.
		// So, we fetch all changes and then check if they are relevant to our app folder.
		// This can be inefficient if the user has many changes outside the app folder.
		// Alternative: Periodically list files (as done in listGoogleDriveFiles) and compare snapshots. (More robust for folder-specific sync)

		// For now, let's proceed with the Changes API and client-side filtering.
		// This means we need the appFolderId to check against.
		const appFolderId = this.settings.googleDriveAppFolderId || await this.findOrCreateAppFolder();
		if (!appFolderId && !this.settings.googleDriveAppFolderId) { // If findOrCreateAppFolder failed and it's not in settings
			// Persist appFolderId in settings after first successful findOrCreateAppFolder
			const foundId = await this.findOrCreateAppFolder();
			if (foundId) this.settings.googleDriveAppFolderId = foundId; // Save it for next time
			else {
				new Notice('App folder ID not available, cannot reliably fetch changes.');
				return null;
			}
		}


		new Notice(`Fetching GDrive changes since token: ${pageToken.substring(0, 20)}...`);
		try {
			// `fields` specifies what information we want for each change and file.
			const fields = "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, modifiedTime, parents, md5Checksum))";
			let url = `https://www.googleapis.com/drive/v3/changes?pageToken=${pageToken}&fields=${fields}&pageSize=100`; // pageSize up to 1000

			const response = await fetch(url, {
				headers: { 'Authorization': `Bearer ${token}` }
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				if (response.status === 401) { // Token expired or revoked
					new Notice('Google Drive token invalid. Please re-authenticate.');
					this.settings.googleDriveAccessToken = undefined; // Clear tokens
					this.settings.googleDriveRefreshToken = undefined;
					this.settings.googleDriveTokenExpiry = undefined;
					this.settings.googleDriveStartPageToken = undefined; // Reset change token
					await this.saveSettings();
				}
				throw new Error(`Failed to fetch changes: ${errorData?.error?.message || response.statusText}`);
			}

			const data = await response.json();

			// Filter changes to only include those relevant to our app folder
			// This is a simplified client-side filter.
			// A file is relevant if it's in the app folder, or if one of its parents is.
			// This doesn't perfectly handle files moved into/out of the app folder in one go,
			// but is a starting point.
			const relevantChanges = data.changes.filter((change: any) => {
				if (change.removed) return true; // Process all removals, sync logic will check if it was our file
				if (!change.file || !change.file.parents) return false; // No parent info, can't determine relevance
				return change.file.parents.includes(this.settings.googleDriveAppFolderId);
			});


			new Notice(`Fetched ${data.changes.length} total GDrive changes, ${relevantChanges.length} relevant. Check console.`);
			console.log("GDrive Changes:", data);
			console.log("Relevant GDrive Changes:", relevantChanges);

			// Update the page token for the next poll
			const nextTokenToSave = data.nextPageToken || data.newStartPageToken;
			if (nextTokenToSave) {
				this.settings.googleDriveStartPageToken = nextTokenToSave;
				await this.saveSettings();
			} else {
				// This case should ideally not happen if the API call was successful
				// and there are more changes or it's waiting for new ones.
				// If newStartPageToken is the same as the one we sent, no changes.
				console.warn("No nextPageToken or newStartPageToken received from GDrive Changes API, but call was successful.");
			}

			return {
				changes: relevantChanges, // Use filtered changes
				nextPageToken: data.nextPageToken, // This is for iterating through current batch of changes if large
				newStartPageToken: data.newStartPageToken // This is the token for the *next* call to /changes
			};

		} catch (error) {
			new Notice(`Error fetching GDrive changes: ${error.message}`);
			console.error('fetchGoogleDriveChanges error:', error);
			if (error.message.includes("pageToken is too old")) {
				// Page token expired, need to get a new one and potentially resync fully
				new Notice("Google Drive pageToken expired. Will attempt to get a new one. Full rescan might be needed.");
				this.settings.googleDriveStartPageToken = undefined; // Force refetch of start token
				await this.saveSettings();
			}
			return null;
		}
	}


	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CloudSyncSettingTab extends PluginSettingTab {
	plugin: CloudSyncPlugin;

	constructor(app: App, plugin: CloudSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Cloud Sync Settings'});

		new Setting(containerEl)
			.setName('Cloud Provider')
			.setDesc('Select your cloud storage provider.')
			.addDropdown(dropdown => dropdown
				.addOption('google-drive', 'Google Drive')
				.addOption('one-drive', 'OneDrive')
				// Add other providers here
				.setValue(this.plugin.settings.cloudProvider)
				.onChange(async (value) => {
					this.plugin.settings.cloudProvider = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh settings tab to show/hide provider-specific settings
				}));

		if (this.plugin.settings.cloudProvider === 'google-drive') {
			new Setting(containerEl)
				.setName('Google Drive Client ID')
				.setDesc('Enter your Google Drive Client ID.')
				.addText(text => text
					.setPlaceholder('Enter your Client ID')
					.setValue(this.plugin.settings.googleDriveClientId)
					.onChange(async (value) => {
						this.plugin.settings.googleDriveClientId = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Google Drive Client Secret')
				.setDesc('Enter your Google Drive Client Secret.')
				.addText(text => text
					.setPlaceholder('Enter your Client Secret')
					.setValue(this.plugin.settings.googleDriveClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.googleDriveClientSecret = value;
						await this.plugin.saveSettings();
					}));
		} else if (this.plugin.settings.cloudProvider === 'one-drive') {
			new Setting(containerEl)
				.setName('OneDrive Client ID')
				.setDesc('Enter your OneDrive Client ID.')
				.addText(text => text
					.setPlaceholder('Enter your Client ID')
					.setValue(this.plugin.settings.oneDriveClientId)
					.onChange(async (value) => {
						this.plugin.settings.oneDriveClientId = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('OneDrive Client Secret')
				.setDesc('Enter your OneDrive Client Secret.')
				.addText(text => text
					.setPlaceholder('Enter your Client Secret')
					.setValue(this.plugin.settings.oneDriveClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.oneDriveClientSecret = value;
						await this.plugin.saveSettings();
					}));
		}
		// Add settings for other providers here
	}
}
