const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * WakaTime Hook for AiderDesk
 * 
 * This hook tracks coding activity by sending heartbeats to WakaTime via wakatime-cli.
 * It relies on a global wakatime-cli installation and configuration (~/.wakatime.cfg).
 */

// Configuration
const WAKATIME_CLI = os.platform() === 'win32' ? 'wakatime-cli.exe' : 'wakatime-cli';
const HEARTBEAT_THROTTLE_MS = 60000; // 1 minute

// State to manage throttling
const lastHeartbeats = new Map();

/**
 * Sends a heartbeat to WakaTime asynchronously
 */
const sendHeartbeat = (context, entity, project, isWrite = false) => {
    if (!entity) {
        return;
    }

    const now = Date.now();
    const lastTime = lastHeartbeats.get(entity) || 0;

    // Throttle heartbeats for the same entity unless it's a write
    if (!isWrite && (now - lastTime < HEARTBEAT_THROTTLE_MS)) {
        return;
    }

    const args = [
        '--entity', entity,
        '--project', project || 'AiderDesk',
        '--plugin', 'aider-desk-hook/1.0.0'
    ];

    if (isWrite) {
        args.push('--write');
    }

    // Use setImmediate to make the spawn truly async and non-blocking
    setImmediate(() => {
        try {
            const proc = spawn(WAKATIME_CLI, args, {
                detached: true,
                stdio: 'ignore',
                timeout: 5000 // Add timeout to prevent hanging
            });

            // Handle process errors
            proc.on('error', (error) => {
                console.error('WakaTime spawn error:', error);
                // Don't add error message to context to avoid disrupting user experience
                // Just log it silently
            });

            // Ensure process cleanup
            proc.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    console.debug(`WakaTime process exited with code ${code}`);
                }
            });

            proc.unref();
        } catch (e) {
            console.error('WakaTime heartbeat error:', e);
            // Don't block the main process with error messages
        }
    });

    lastHeartbeats.set(entity, now);
};

/**
 * Extracts the primary file from a prompt or context
 */
const getPrimaryFile = (context) => {
    const files = context.task.contextManager.getContextFiles();
    if (files.length > 0) {
        // Return absolute path of the first context file
        return path.isAbsolute(files[0].path) 
            ? files[0].path 
            : path.join(context.projectDir, files[0].path);
    }
    return context.projectDir; // Fallback to project directory
};

module.exports = {
    // Triggered when a prompt starts (Aider or Agent)
    onPromptStarted: async (event, context) => {
        const entity = getPrimaryFile(context);
        sendHeartbeat(context, entity, path.basename(context.projectDir), false);
    },

    // Triggered when Aider finishes and might have edited files
    onAiderPromptFinished: async (event, context) => {
        const project = path.basename(context.projectDir);
        const editedFiles = event.responses
            .flatMap(r => r.editedFiles || [])
            .map(f => path.isAbsolute(f) ? f : path.join(context.projectDir, f));

        if (editedFiles.length > 0) {
            editedFiles.forEach(file => sendHeartbeat(context, file, project, true));
        } else {
            sendHeartbeat(context, getPrimaryFile(context), project, false);
        }
    },

    // Triggered when a tool finishes in Agent mode
    onToolFinished: async (event, context) => {
        const { toolName, args } = event;
        const project = path.basename(context.projectDir);

        // Track file writes in Agent mode
        if ((toolName === 'write_file' || toolName === 'edit_file') && args.path) {
            const fullPath = path.isAbsolute(args.path) ? args.path : path.join(context.projectDir, args.path);
            sendHeartbeat(context, fullPath, project, true);
        } else {
            sendHeartbeat(context, getPrimaryFile(context), project, false);
        }
    },

    // Track activity when files are added to context
    onFileAdded: async (event, context) => {
        const fullPath = path.isAbsolute(event.file.path) ? event.file.path : path.join(context.projectDir, event.file.path);
        sendHeartbeat(context, fullPath, path.basename(context.projectDir), false);
    }
};
